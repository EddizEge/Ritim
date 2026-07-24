#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Kullanım: $0 <şifreli-yedek-veya-dizin>" >&2
  exit 2
fi

readonly SOURCE_ROOT="${RITIM_SOURCE_ROOT:-/DATA/AppData/ritim-alpha2/source}"
readonly COMPOSE_FILE="${SOURCE_ROOT}/deploy/pi/compose.alpha2.yml"
readonly ENV_FILE="${SOURCE_ROOT}/deploy/pi/.env"
readonly PASSPHRASE_FILE="${RITIM_BACKUP_PASSPHRASE_FILE:-/DATA/AppData/ritim-alpha2/secrets/backup-passphrase}"
readonly RESTORE_DATABASE="ritim_restore_smoke"
readonly LOCK_FILE="/run/lock/ritim-alpha2-restore.lock"

if [[ -d "$1" ]]; then
  BACKUP_PATH="$(find "$1" -maxdepth 1 -type f -name 'ritim-alpha2-*.pgdump.enc' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
else
  BACKUP_PATH="$1"
fi
readonly BACKUP_PATH

for required in "$COMPOSE_FILE" "$ENV_FILE" "$PASSPHRASE_FILE" "$BACKUP_PATH"; do
  if [[ ! -f "$required" ]]; then
    echo "Gerekli dosya bulunamadı: $required" >&2
    exit 1
  fi
done

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Başka bir Ritim geri yükleme provası halen çalışıyor." >&2
  exit 1
}

compose_exec() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres "$@"
}

drop_smoke_database() {
  compose_exec sh -ec \
    'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists ritim_restore_smoke with (force)"' \
    >/dev/null
}
trap drop_smoke_database EXIT

drop_smoke_database
compose_exec sh -ec \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "create database ritim_restore_smoke"' \
  >/dev/null

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:${PASSPHRASE_FILE}" -in "$BACKUP_PATH" \
  | compose_exec sh -ec \
      'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore -U "$POSTGRES_USER" -d ritim_restore_smoke --no-owner --no-privileges --exit-on-error'

compose_exec sh -ec \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d ritim_restore_smoke -v ON_ERROR_STOP=1 -Atc "
    select json_build_object(
      '\''users'\'', (select count(*) from ritim.users),
      '\''devices'\'', (select count(*) from ritim.devices),
      '\''messages'\'', (select count(*) from ritim.messages),
      '\''rooms'\'', (select count(*) from ritim.listening_rooms)
    );
  "'
