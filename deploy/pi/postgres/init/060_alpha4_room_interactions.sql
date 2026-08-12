\set ON_ERROR_STOP on

create table if not exists ritim.room_messages (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  room_id bigint not null references ritim.listening_rooms(id) on delete cascade,
  sender_id bigint not null references ritim.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 280),
  sent_at timestamptz not null default now()
);

create index if not exists room_messages_room_timeline_idx
  on ritim.room_messages (room_id, sent_at desc, id desc);

grant select, insert, delete on ritim.room_messages to ritim_app;
grant usage, select on sequence ritim.room_messages_id_seq to ritim_app;
