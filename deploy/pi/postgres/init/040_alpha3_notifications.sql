\set ON_ERROR_STOP on

create table if not exists ritim.message_reactions (
  message_id bigint not null references ritim.messages(id) on delete cascade,
  actor_id bigint not null references ritim.users(id) on delete cascade,
  reaction text not null check (reaction in ('♥', '🔥', '😂', '👍')),
  created_at timestamptz not null default now(),
  primary key (message_id, actor_id)
);
create index if not exists message_reactions_actor_idx
  on ritim.message_reactions (actor_id, created_at desc);

create table if not exists ritim.notification_preferences (
  user_id bigint primary key references ritim.users(id) on delete cascade,
  messages_enabled boolean not null default true,
  reactions_enabled boolean not null default true,
  device_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists ritim.social_notifications (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  recipient_id bigint not null references ritim.users(id) on delete cascade,
  actor_id bigint references ritim.users(id) on delete set null,
  kind text not null check (kind in ('message_request', 'message', 'reaction')),
  message_id bigint references ritim.messages(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists social_notifications_recipient_timeline_idx
  on ritim.social_notifications (recipient_id, created_at desc, id desc);
create index if not exists social_notifications_recipient_unread_idx
  on ritim.social_notifications (recipient_id, created_at desc)
  where read_at is null;
create unique index if not exists social_notifications_event_unique_idx
  on ritim.social_notifications (recipient_id, actor_id, kind, message_id)
  where message_id is not null;

grant select, insert, update, delete on ritim.message_reactions to ritim_app;
grant select, insert, update on ritim.notification_preferences to ritim_app;
grant select, insert, update on ritim.social_notifications to ritim_app;
grant usage, select on all sequences in schema ritim to ritim_app;
