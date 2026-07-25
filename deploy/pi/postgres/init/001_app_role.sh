#!/usr/bin/env sh
set -eu

if [ -z "${RITIM_DB_APP_PASSWORD:-}" ]; then
  echo "RITIM_DB_APP_PASSWORD gerekli." >&2
  exit 1
fi

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$RITIM_DB_APP_PASSWORD" <<'SQL'
select 'create role ritim_app login nosuperuser nocreatedb nocreaterole noinherit'
where not exists (select 1 from pg_roles where rolname = 'ritim_app')
\gexec

alter role ritim_app password :'app_password';
SQL
