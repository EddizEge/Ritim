#!/usr/bin/env bash
# Runs the opt-in social gateway tests against disposable PostgreSQL 17 and
# Redis 7 containers. Used by the CI `social-gateway` job; it can also run on
# a developer machine with Docker. It never contacts the production gateway.
#
# Every credential is random and lives only for this run. Containers and the
# gateway processes started here are the only ones stopped on exit.
#
# Optional environment:
#   RITIM_CI_PG_PORT, RITIM_CI_REDIS_PORT, RITIM_CI_GATEWAY_PORT,
#   RITIM_CI_AUTH_GATEWAY_PORT  loopback ports (defaults 55432/56379/58790/58791)
#   RITIM_CI_LOG_DIR            gateway log directory (default: a temp dir)
set -euo pipefail

cd "$(dirname "$0")/../.."

random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(Number(process.argv[1])).toString('hex'))" "$1"
}

run_id="$(random_hex 4)"
pg_port="${RITIM_CI_PG_PORT:-55432}"
redis_port="${RITIM_CI_REDIS_PORT:-56379}"
gateway_port="${RITIM_CI_GATEWAY_PORT:-58790}"
auth_gateway_port="${RITIM_CI_AUTH_GATEWAY_PORT:-58791}"
log_dir="${RITIM_CI_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$log_dir"
pg_container="ritim-ci-postgres-$run_id"
redis_container="ritim-ci-redis-$run_id"
admin_password="$(random_hex 24)"
app_password="$(random_hex 24)"
redis_password="$(random_hex 24)"
jwt_secret="$(random_hex 32)"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  for secret in "$admin_password" "$app_password" "$redis_password" "$jwt_secret"; do
    echo "::add-mask::$secret"
  done
fi

export RITIM_DB_HOST=127.0.0.1
export RITIM_DB_PORT="$pg_port"
export RITIM_DB_NAME=ritim
export RITIM_DB_USER=ritim_app
export RITIM_DB_PASSWORD="$app_password"
export RITIM_REDIS_HOST=127.0.0.1
export RITIM_REDIS_PORT="$redis_port"
export RITIM_REDIS_PASSWORD="$redis_password"
export RITIM_INFRA_REQUIRED=true
export RITIM_SOCKET_RATE_CONNECTIONS=200
# Format-valid placeholder: Google is never called, the auth test uses a fake
# identity provider and only needs the client id to be on the allow list.
auth_environment=(
  RITIM_AUTH_REQUIRED=true
  RITIM_AUTH_JWT_SECRET="$jwt_secret"
  RITIM_GOOGLE_CLIENT_IDS=ritim-ci-test.apps.googleusercontent.com
)

gateway_pid=""
auth_gateway_pid=""

stop_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  stop_pid "$gateway_pid"
  stop_pid "$auth_gateway_pid"
  if [ "$status" -ne 0 ]; then
    for log in "$log_dir"/*.log; do
      [ -f "$log" ] || continue
      echo "----- $log"
      tail -n 80 "$log"
    done
    docker logs "$pg_container" 2>&1 | tail -n 40 || true
  fi
  docker stop "$pg_container" "$redis_container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

init_dir="$PWD/deploy/pi/postgres/init"
if command -v cygpath >/dev/null 2>&1; then init_dir="$(cygpath -w "$init_dir")"; fi

echo "PostgreSQL ve Redis container'ları başlatılıyor ($run_id)"
MSYS_NO_PATHCONV=1 docker run -d --rm --name "$pg_container" \
  -p "127.0.0.1:$pg_port:5432" \
  -e POSTGRES_DB=ritim \
  -e POSTGRES_USER=ritim_admin \
  -e POSTGRES_PASSWORD="$admin_password" \
  -e RITIM_DB_APP_PASSWORD="$app_password" \
  -v "$init_dir:/docker-entrypoint-initdb.d:ro" \
  postgres:17-alpine >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --rm --name "$redis_container" \
  -p "127.0.0.1:$redis_port:6379" \
  -e RITIM_REDIS_PASSWORD="$redis_password" \
  redis:7-alpine sh -ec 'exec redis-server --requirepass "$RITIM_REDIS_PASSWORD"' >/dev/null

# The init scripts run on a socket-only temporary server; TCP readiness plus
# an app-role login means every migration has finished.
for attempt in $(seq 1 90); do
  if docker exec -e PGPASSWORD="$app_password" "$pg_container" \
    psql -h 127.0.0.1 -U ritim_app -d ritim -Atc 'select count(*) from ritim.users' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo "PostgreSQL hazır olmadı." >&2
    exit 1
  fi
  sleep 1
done
docker exec -e REDISCLI_AUTH="$redis_password" "$redis_container" redis-cli ping | grep -q PONG

echo "020+ geçişlerinin tekrar uygulanabilirliği denetleniyor"
for migration in deploy/pi/postgres/init/0[2-9]*.sql; do
  docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -q -U ritim_admin -d ritim <"$migration" >/dev/null
done

wait_ready() {
  local port="$1" pid="$2"
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Gateway ($port) erken kapandı." >&2
      return 1
    fi
    curl --silent --fail "http://127.0.0.1:$port/ready" >/dev/null && return 0
    sleep 0.5
  done
  echo "Gateway ($port) hazır olmadı." >&2
  return 1
}

start_gateway() {
  RITIM_SOCIAL_PORT="$gateway_port" RITIM_AUTH_REQUIRED=false RITIM_AUTH_JWT_SECRET= RITIM_GOOGLE_CLIENT_IDS= \
    node --import tsx server/social.ts >>"$log_dir/gateway.log" 2>&1 &
  gateway_pid=$!
  wait_ready "$gateway_port" "$gateway_pid"
}

start_auth_gateway() {
  env "${auth_environment[@]}" RITIM_SOCIAL_PORT="$auth_gateway_port" \
    node --import tsx server/social.ts >>"$log_dir/auth-gateway.log" 2>&1 &
  auth_gateway_pid=$!
  wait_ready "$auth_gateway_port" "$auth_gateway_pid"
}

# A missing variable makes these opt-in tests skip silently, so every run must
# report exactly the expected number of skipped tests.
test_run=0
run_tests() {
  local expected_skips="$1"
  shift
  test_run=$((test_run + 1))
  local output="$log_dir/tests-$test_run.out"
  "$@" 2>&1 | tee "$output"
  if ! grep -Eq "skipped $expected_skips\$" "$output"; then
    echo "Atlanan test sayısı $expected_skips değil: $*" >&2
    return 1
  fi
}

gateway_url="http://127.0.0.1:$gateway_port"
auth_gateway_url="http://127.0.0.1:$auth_gateway_port"

echo "Kalıcı store testleri"
run_tests 0 env RITIM_SOCIAL_STORE_TEST=true \
  node --import tsx --test --test-reporter=spec tests/social-store-postgres.test.ts

echo "Tokensız gateway (RITIM_AUTH_REQUIRED=false)"
start_gateway
run_tests 0 env RITIM_SOCIAL_TEST_URL="$gateway_url" \
  node --test --test-reporter=spec tests/social-gateway-message-requests.test.cjs
run_tests 1 env RITIM_SOCIAL_TEST_URL="$gateway_url" RITIM_SOCIAL_TEST_PHASE=seed \
  node --test --test-reporter=spec tests/social-gateway-persistence.test.cjs

echo "Gateway yeniden başlatılıyor; veriler PostgreSQL/Redis'ten gelmeli"
stop_pid "$gateway_pid"
gateway_pid=""
start_gateway
run_tests 1 env RITIM_SOCIAL_TEST_URL="$gateway_url" RITIM_SOCIAL_TEST_PHASE=restart \
  node --test --test-reporter=spec tests/social-gateway-persistence.test.cjs
run_tests 0 env RITIM_SOCIAL_TEST_URL="$gateway_url" RITIM_SOCIAL_TEST_PHASE=access \
  node --test --test-reporter=spec tests/social-gateway-persistence.test.cjs

echo "Kimlik zorunlu gateway (RITIM_AUTH_REQUIRED=true)"
start_auth_gateway
run_tests 0 env "${auth_environment[@]}" \
  RITIM_SOCIAL_AUTH_TEST_URL="$auth_gateway_url" RITIM_SOCIAL_AUTH_TEST_MINT=true \
  node --import tsx --test --test-reporter=spec tests/social-gateway-auth.test.cjs
npm run build:social
env "${auth_environment[@]}" RITIM_SOCIAL_TEST_URL="$auth_gateway_url" RITIM_SOCIAL_LIVE_ADMIN_TEST=true \
  node tests/social-gateway-policies.test.mjs | tee "$log_dir/policies.out"
grep -q '"ok":true' "$log_dir/policies.out"

echo "Sosyal gateway uçtan uca testleri geçti."
