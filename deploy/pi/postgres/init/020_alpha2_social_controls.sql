\set ON_ERROR_STOP on

create table if not exists ritim.reactions (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  actor_id bigint not null references ritim.users(id) on delete cascade,
  target_id bigint not null references ritim.users(id) on delete cascade,
  reaction text not null check (char_length(reaction) between 1 and 8),
  created_at timestamptz not null default now(),
  constraint reactions_not_self check (actor_id <> target_id)
);
create index if not exists reactions_target_timeline_idx
  on ritim.reactions (target_id, created_at desc, id desc);
create index if not exists reactions_actor_created_idx
  on ritim.reactions (actor_id, created_at desc);

grant select, insert on ritim.reactions to ritim_app;
grant usage, select on all sequences in schema ritim to ritim_app;
