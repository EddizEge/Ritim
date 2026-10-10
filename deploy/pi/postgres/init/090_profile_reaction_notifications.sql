\set ON_ERROR_STOP on

-- Aşama 3: biri başka bir kullanıcının profiline tepki verince hedefe
-- 'profile_reaction' bildirimi düşer (message_id boş, body = emoji).
-- 040'taki satır içi CHECK kısıtı PostgreSQL'in verdiği
-- social_notifications_kind_check adını taşır; ad farklı kurulmuş bir
-- veritabanında da kalmasın diye 'kind' sütununa bakan bütün CHECK kısıtları
-- kaldırılıp yeni listeyle tek bir adlı kısıt eklenir.
-- Aynı kişiden okunmamış tek bir profil tepkisi bildirimi tutulur; kısmi
-- benzersiz indeks hem bu aramayı hem de gateway'in
-- "on conflict ... do update" birleştirmesini karşılar.
-- Betik idempotenttir; tek işlem içinde çalışır.
begin;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_row.conname
    from pg_constraint constraint_row
    join pg_attribute attribute_row
      on attribute_row.attrelid = constraint_row.conrelid
     and attribute_row.attnum = any(constraint_row.conkey)
    where constraint_row.conrelid = 'ritim.social_notifications'::regclass
      and constraint_row.contype = 'c'
      and attribute_row.attname = 'kind'
  loop
    execute format('alter table ritim.social_notifications drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table ritim.social_notifications
  add constraint social_notifications_kind_check
  check (kind in ('message_request', 'message', 'reaction', 'profile_reaction'));

create unique index if not exists social_notifications_profile_reaction_unread_idx
  on ritim.social_notifications (recipient_id, actor_id)
  where kind = 'profile_reaction' and read_at is null;

commit;
