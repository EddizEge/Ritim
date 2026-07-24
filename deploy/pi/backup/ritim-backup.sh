#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Kullanım: $0 <hedef-dizin> <saklama-günü>" >&2
  exit 2
fi

readonly SOURCE_ROOT="${RITIM_SOURCE_ROOT:-/DATA/AppData/ritim-alpha2/source}"
readonly COMPOSE_FILE="${SOURCE_ROOT}/deploy/pi/compose.alpha2.yml"
readonly ENV_FILE="${SOURCE_ROOT}/deploy/pi/.env"
readonly PASSPHRASE_FILE="${RITIM_BACKUP_PASSPHRASE_FILE:-/DATA/AppData/ritim-alpha2/secrets/backup-passphrase}"
readonly TARGET_DIR="$1"
readonly RETENTION_DAYS="$2"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly FINAL_PATH="${TARGET_DIR}/ritim-alpha2-${TIMESTAMP}.pgdump.enc"
readonly TEMP_PATH="${FINAL_PATH}.partial"
readonly LOCK_FILE="/run/lock/ritim-alpha2-backup.lock"

for required in "$COMPOSE_FILE" "$ENV_FILE" "$PASSPHRASE_FILE"; do
  if [[ ! -f "$required" ]]; then
    echo "Gerekli dosya bulunamadı: $required" >&2
    exit 1
  fi
done
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 )); then
  echo "Saklama günü pozitif tam sayı olmalıdır." >&2
  exit 2
fi

umask 077
mkdir -p -- "$TARGET_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Başka bir Ritim yedeği halen çalışıyor." >&2
  exit 1
}
trap 'rm -f -- "$TEMP_PATH"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  sh -ec 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:${PASSPHRASE_FILE}" -out "$TEMP_PATH"

test -s "$TEMP_PATH"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${PASSPHRASE_FILE}" -in "$TEMP_PATH" \
  | docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres pg_restore --list >/dev/null

mv -- "$TEMP_PATH" "$FINAL_PATH"
find "$TARGET_DIR" -maxdepth 1 -type f -name 'ritim-alpha2-*.pgdump.enc' -mtime "+${RETENTION_DAYS}" -delete
printf '%s\n' "$FINAL_PATH"
