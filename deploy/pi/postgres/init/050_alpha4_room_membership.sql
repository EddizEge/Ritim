\set ON_ERROR_STOP on

-- Alpha.1/Alpha.3 prototiplerinde aynı kullanıcı bir oda sahibiyken başka bir
-- odada dinleyici kalmış olabilir. Alpha.4 öncesinde tek aktif üyeliğe indir.
with ranked_memberships as (
  select
    room_id,
    user_id,
    row_number() over (
      partition by user_id
      order by
        case when role = 'owner' then 0 else 1 end,
        joined_at desc,
        room_id desc
    ) as membership_rank
  from ritim.room_members
  where left_at is null
)
update ritim.room_members member
set left_at = now()
from ranked_memberships ranked
where member.room_id = ranked.room_id
  and member.user_id = ranked.user_id
  and ranked.membership_rank > 1;

create unique index if not exists room_members_one_active_room_idx
  on ritim.room_members (user_id)
  where left_at is null;
