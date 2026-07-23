\set ON_ERROR_STOP on

revoke create on schema public from public;
revoke all on database :DBNAME from public;
grant connect on database :DBNAME to ritim_app;

create schema if not exists ritim;
revoke all on schema ritim from public;

create table ritim.users (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  legacy_account_id_hash bytea unique,
  oidc_issuer text,
  oidc_subject text,
  display_name text not null check (char_length(display_name) between 1 and 60),
  handle text not null check (handle ~ '^@[a-z0-9_]{3,32}$'),
  initials text not null default 'R' check (char_length(initials) between 1 and 3),
  avatar_tone smallint not null default 0 check (avatar_tone between 0 and 11),
  avatar_url text,
  profile_visibility text not null default 'everyone'
    check (profile_visibility in ('everyone', 'contacts', 'hidden')),
  listening_visibility text not null default 'everyone'
    check (listening_visibility in ('everyone', 'contacts', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_oidc_identity_complete check (
    (oidc_issuer is null and oidc_subject is null)
    or (oidc_issuer is not null and oidc_subject is not null)
  ),
  constraint users_oidc_identity_unique unique (oidc_issuer, oidc_subject)
);

create unique index users_handle_lower_idx on ritim.users (lower(handle));

create table ritim.devices (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  user_id bigint not null references ritim.users(id) on delete cascade,
  device_type text not null check (device_type in ('desktop', 'companion')),
  display_name text not null check (char_length(display_name) between 1 and 80),
  device_key_hash bytea not null unique,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index devices_user_id_idx on ritim.devices (user_id);
create index devices_active_user_idx on ritim.devices (user_id, last_seen_at desc)
  where revoked_at is null;

create table ritim.sessions (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  user_id bigint not null references ritim.users(id) on delete cascade,
  device_id bigint not null references ritim.devices(id) on delete cascade,
  refresh_token_hash bytea not null unique,
  token_family_id uuid not null default gen_random_uuid(),
  parent_session_id bigint references ritim.sessions(id) on delete set null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  reuse_detected_at timestamptz,
  created_at timestamptz not null default now()
);
create index sessions_user_id_idx on ritim.sessions (user_id);
create index sessions_device_id_idx on ritim.sessions (device_id);
create index sessions_parent_session_id_idx on ritim.sessions (parent_session_id)
  where parent_session_id is not null;
create index sessions_active_expiry_idx on ritim.sessions (expires_at)
  where revoked_at is null;
create index sessions_active_family_idx on ritim.sessions (token_family_id, created_at desc)
  where revoked_at is null;

create table ritim.conversations (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  kind text not null default 'direct' check (kind in ('direct')),
  direct_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_direct_key_required check (kind <> 'direct' or direct_key is not null)
);

create table ritim.conversation_members (
  conversation_id bigint not null references ritim.conversations(id) on delete cascade,
  user_id bigint not null references ritim.users(id) on delete cascade,
  last_read_message_id bigint,
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_id_idx on ritim.conversation_members (user_id, conversation_id);
create index conversation_members_last_read_message_id_idx
  on ritim.conversation_members (last_read_message_id)
  where last_read_message_id is not null;

create table ritim.messages (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  conversation_id bigint not null references ritim.conversations(id) on delete cascade,
  sender_id bigint not null references ritim.users(id) on delete restrict,
  client_message_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000),
  sent_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_sender_client_unique unique (sender_id, client_message_id)
);
create index messages_conversation_timeline_idx
  on ritim.messages (conversation_id, sent_at desc, id desc);
create index messages_sender_id_idx on ritim.messages (sender_id);

alter table ritim.conversation_members
  add constraint conversation_members_last_read_message_id_fkey
  foreign key (last_read_message_id) references ritim.messages(id) on delete set null;

create table ritim.blocks (
  blocker_id bigint not null references ritim.users(id) on delete cascade,
  blocked_id bigint not null references ritim.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_id_idx on ritim.blocks (blocked_id);

create table ritim.reports (
  id bigint generated always as identity primary key,
  reporter_id bigint not null references ritim.users(id) on delete restrict,
  reported_user_id bigint not null references ritim.users(id) on delete restrict,
  message_id bigint references ritim.messages(id) on delete set null,
  reason text not null check (char_length(reason) between 3 and 120),
  detail text check (detail is null or char_length(detail) <= 2000),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint reports_not_self check (reporter_id <> reported_user_id)
);
create index reports_reporter_id_idx on ritim.reports (reporter_id);
create index reports_reported_user_id_idx on ritim.reports (reported_user_id);
create index reports_message_id_idx on ritim.reports (message_id)
  where message_id is not null;
create index reports_open_created_idx on ritim.reports (created_at)
  where status in ('open', 'reviewing');

create table ritim.listening_rooms (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  owner_id bigint not null references ritim.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  cover smallint not null default 0 check (cover between 0 and 11),
  current_video_id text,
  playback_position_ms integer not null default 0 check (playback_position_ms >= 0),
  playback_state text not null default 'paused' check (playback_state in ('playing', 'paused')),
  playback_revision bigint not null default 0 check (playback_revision >= 0),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index listening_rooms_owner_id_idx on ritim.listening_rooms (owner_id);
create unique index listening_rooms_one_active_owner_idx on ritim.listening_rooms (owner_id)
  where ended_at is null;

create table ritim.room_members (
  room_id bigint not null references ritim.listening_rooms(id) on delete cascade,
  user_id bigint not null references ritim.users(id) on delete cascade,
  device_id bigint references ritim.devices(id) on delete set null,
  role text not null default 'listener' check (role in ('owner', 'listener')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (room_id, user_id)
);
create index room_members_user_id_idx on ritim.room_members (user_id, room_id);
create index room_members_device_id_idx on ritim.room_members (device_id)
  where device_id is not null;

create function ritim.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_touch_updated_at
before update on ritim.users
for each row execute function ritim.touch_updated_at();

create trigger conversations_touch_updated_at
before update on ritim.conversations
for each row execute function ritim.touch_updated_at();

create trigger listening_rooms_touch_updated_at
before update on ritim.listening_rooms
for each row execute function ritim.touch_updated_at();

grant usage on schema ritim to ritim_app;
grant select, insert, update on ritim.users to ritim_app;
grant select, insert, update, delete on ritim.devices to ritim_app;
grant select, insert, update, delete on ritim.sessions to ritim_app;
grant select, insert, update on ritim.conversations to ritim_app;
grant select, insert, update, delete on ritim.conversation_members to ritim_app;
grant select, insert on ritim.messages to ritim_app;
grant select, insert, delete on ritim.blocks to ritim_app;
grant select, insert on ritim.reports to ritim_app;
grant select, insert, update on ritim.listening_rooms to ritim_app;
grant select, insert, update, delete on ritim.room_members to ritim_app;
grant usage, select on all sequences in schema ritim to ritim_app;
