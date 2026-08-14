\set ON_ERROR_STOP on

create table if not exists ritim.message_requests (
  conversation_id bigint primary key references ritim.conversations(id) on delete cascade,
  requester_id bigint not null references ritim.users(id) on delete cascade,
  recipient_id bigint not null references ritim.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint message_requests_not_self check (requester_id <> recipient_id)
);

create index if not exists message_requests_recipient_pending_idx
  on ritim.message_requests (recipient_id, created_at desc)
  where status = 'pending';
create index if not exists message_requests_requester_pending_idx
  on ritim.message_requests (requester_id, created_at desc)
  where status = 'pending';

-- Alpha.2 döneminde kurulmuş konuşmalar yeni istek ekranına düşmemeli.
insert into ritim.message_requests (
  conversation_id, requester_id, recipient_id, status, created_at, responded_at
)
select
  conversation.id,
  first_message.sender_id,
  peer_member.user_id,
  'accepted',
  conversation.created_at,
  conversation.updated_at
from ritim.conversations conversation
join lateral (
  select message.sender_id
  from ritim.messages message
  where message.conversation_id = conversation.id
  order by message.sent_at asc, message.id asc
  limit 1
) first_message on true
join ritim.conversation_members peer_member
  on peer_member.conversation_id = conversation.id
 and peer_member.user_id <> first_message.sender_id
where conversation.kind = 'direct'
on conflict (conversation_id) do nothing;

grant select, insert, update on ritim.message_requests to ritim_app;
