import crypto from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

type RedisTransaction = {
  set: (...args: any[]) => RedisTransaction
  sAdd: (...args: any[]) => RedisTransaction
  expire: (...args: any[]) => RedisTransaction
  del: (...args: any[]) => RedisTransaction
  sRem: (...args: any[]) => RedisTransaction
  exec: () => Promise<unknown>
}

type RedisClient = {
  multi: () => RedisTransaction
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, options?: { EX: number }) => Promise<unknown>
  del: (key: string) => Promise<unknown>
  mGet: (keys: string[]) => Promise<(string | null)[]>
}

type SocialProfile = {
  id: string
  displayName: string
  handle: string
  initials: string
  avatarUrl?: string
  avatarTone: number
  deviceRole: 'desktop' | 'companion'
  currentTrack?: unknown
}

type StoredMessage = {
  id: string
  senderId: string
  targetId: string
  text: string
  sentAt: number
}

type StoredRoom = {
  id: string
  ownerId: string
  title: string
  cover: number
  memberCount: number
  memberInitials: string[]
}

type StoredReaction = {
  actorId: string
  targetId: string
  reaction: string
}

type Visibility = 'everyone' | 'contacts' | 'hidden'

type PrivacyPreferences = {
  profileVisibility: Visibility
  listeningVisibility: Visibility
}

type AccessRule = {
  profile: boolean
  listening: boolean
}

const PRESENCE_TTL_SECONDS = 60
const PRESENCE_SET_TTL_SECONDS = 120
const LISTENING_TTL_SECONDS = 120
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest()
}

function hashHex(value: string) {
  return sha256(value).toString('hex')
}

function accountKey(value: string) {
  return UUID_PATTERN.test(value) ? value : hashHex(value)
}

function databaseHandle(profileHandle: string, accountHash: Buffer) {
  const prefix = String(profileHandle || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 18) || 'ritim'
  return `@${prefix}_${accountHash.toString('hex').slice(0, 12)}`
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("set local statement_timeout = '5s'")
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function findUserId(client: PoolClient, accountId: string) {
  const result = UUID_PATTERN.test(accountId)
    ? await client.query<{ id: string }>(
        'select id from ritim.users where public_id = $1',
        [accountId],
      )
    : await client.query<{ id: string }>(
        'select id from ritim.users where legacy_account_id_hash = $1',
        [sha256(accountId)],
      )
  return result.rows[0]?.id
}

async function usersCanInteract(client: PoolClient, leftId: string, rightId: string) {
  const result = await client.query<{ allowed: boolean }>(
    `select (
       not exists (
         select 1 from ritim.blocks
         where (blocker_id = $1 and blocked_id = $2)
            or (blocker_id = $2 and blocked_id = $1)
       )
       and exists (
         select 1 from ritim.users target
         where target.id = $2
           and (
             target.profile_visibility = 'everyone'
             or (
               target.profile_visibility = 'contacts'
               and exists (
                 select 1
                 from ritim.conversation_members left_member
                 join ritim.conversation_members right_member
                   on right_member.conversation_id = left_member.conversation_id
                  and right_member.user_id = $2
                 where left_member.user_id = $1
               )
             )
           )
       )
     ) as allowed`,
    [leftId, rightId],
  )
  return Boolean(result.rows[0]?.allowed)
}

export function createDurableSocialStore(pool: Pool, redis: RedisClient) {
  async function upsertProfile(accountId: string, deviceId: string, profile: SocialProfile) {
    const accountHash = sha256(accountId)
    const deviceHash = sha256(deviceId)

    await inTransaction(pool, async (client) => {
      if (UUID_PATTERN.test(accountId) && UUID_PATTERN.test(deviceId)) {
        const userResult = await client.query<{ id: string }>(
          `update ritim.users
           set display_name = $2,
               initials = $3,
               avatar_tone = $4,
               avatar_url = $5
           where public_id = $1
           returning id`,
          [
            accountId,
            profile.displayName,
            profile.initials,
            profile.avatarTone,
            profile.avatarUrl || null,
          ],
        )
        const userId = userResult.rows[0]?.id
        if (!userId) throw new Error('Doğrulanmış sosyal kullanıcı bulunamadı.')
        const deviceResult = await client.query(
          `update ritim.devices
           set device_type = $3,
               last_seen_at = now()
           where public_id = $1 and user_id = $2 and revoked_at is null`,
          [deviceId, userId, profile.deviceRole],
        )
        if (!deviceResult.rowCount) throw new Error('Doğrulanmış sosyal cihaz bulunamadı.')
        return
      }

      const userResult = await client.query<{ id: string }>(
        `insert into ritim.users (
          legacy_account_id_hash, display_name, handle, initials, avatar_tone, avatar_url
        ) values ($1, $2, $3, $4, $5, $6)
        on conflict (legacy_account_id_hash) do update set
          display_name = excluded.display_name,
          handle = excluded.handle,
          initials = excluded.initials,
          avatar_tone = excluded.avatar_tone,
          avatar_url = excluded.avatar_url
        returning id`,
        [
          accountHash,
          profile.displayName,
          databaseHandle(profile.handle, accountHash),
          profile.initials,
          profile.avatarTone,
          profile.avatarUrl || null,
        ],
      )
      const userId = userResult.rows[0].id
      await client.query(
        `insert into ritim.devices (
          user_id, device_type, display_name, device_key_hash, last_seen_at
        ) values ($1, $2, $3, $4, now())
        on conflict (device_key_hash) do update set
          user_id = excluded.user_id,
          device_type = excluded.device_type,
          display_name = excluded.display_name,
          last_seen_at = now(),
          revoked_at = null`,
        [userId, profile.deviceRole, deviceId.slice(0, 80), deviceHash],
      )
    })

    await touchPresence(accountId, deviceId, profile)
  }

  async function touchPresence(accountId: string, deviceId: string, profile: SocialProfile) {
    const accountKey = hashHex(accountId)
    const deviceKey = hashHex(deviceId)
    await redis.multi()
      .set(`ritim:presence:device:${deviceKey}`, JSON.stringify({
        account: accountKey,
        deviceRole: profile.deviceRole,
        displayName: profile.displayName,
        currentTrack: profile.currentTrack,
        touchedAt: Date.now(),
      }), { EX: PRESENCE_TTL_SECONDS })
      .sAdd(`ritim:presence:account:${accountKey}`, deviceKey)
      .expire(`ritim:presence:account:${accountKey}`, PRESENCE_SET_TTL_SECONDS)
      .exec()
  }

  async function removePresence(accountId: string, deviceId: string) {
    const accountKey = hashHex(accountId)
    const deviceKey = hashHex(deviceId)
    await redis.multi()
      .del(`ritim:presence:device:${deviceKey}`)
      .sRem(`ritim:presence:account:${accountKey}`, deviceKey)
      .exec()
  }

  async function saveMessage(message: StoredMessage) {
    await inTransaction(pool, async (client) => {
      const senderId = await findUserId(client, message.senderId)
      const targetId = await findUserId(client, message.targetId)
      if (!senderId || !targetId || senderId === targetId) throw new Error('Mesaj kullanıcıları bulunamadı.')
      if (!await usersCanInteract(client, senderId, targetId)) throw new Error('Mesajlaşma engellendi.')

      const orderedUserIds = [BigInt(senderId), BigInt(targetId)].sort((left, right) => left < right ? -1 : 1)
      const directKey = `${orderedUserIds[0]}:${orderedUserIds[1]}`
      const conversationResult = await client.query<{ id: string }>(
        `insert into ritim.conversations (kind, direct_key)
         values ('direct', $1)
         on conflict (direct_key) do update set updated_at = now()
         returning id`,
        [directKey],
      )
      const conversationId = conversationResult.rows[0].id
      await client.query(
        `insert into ritim.conversation_members (conversation_id, user_id)
         values ($1, $2), ($1, $3)
         on conflict (conversation_id, user_id) do nothing`,
        [conversationId, orderedUserIds[0].toString(), orderedUserIds[1].toString()],
      )
      await client.query(
        `insert into ritim.messages (
          public_id, conversation_id, sender_id, client_message_id, body, sent_at
        ) values ($1, $2, $3, $1, $4, $5)
        on conflict (sender_id, client_message_id) do nothing`,
        [message.id, conversationId, senderId, message.text, new Date(message.sentAt)],
      )
    })
  }

  async function loadMessages(accountIds: string[]): Promise<StoredMessage[]> {
    if (accountIds.length < 2) return []
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const placeholders = keys.map((_value, index) => `$${index + 1}`).join(', ')
    const result = await pool.query<{
      public_id: string
      sender_key: string
      target_key: string
      body: string
      sent_at: Date
    }>(
      `select public_id, sender_key, target_key, body, sent_at
       from (
         select
           m.public_id,
           coalesce(encode(sender.legacy_account_id_hash, 'hex'), sender.public_id::text) as sender_key,
           coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text) as target_key,
           m.body,
           m.sent_at,
           m.id,
           row_number() over (
             partition by m.conversation_id order by m.sent_at desc, m.id desc
           ) as message_rank
         from ritim.messages m
         join ritim.users sender on sender.id = m.sender_id
         join ritim.conversation_members target_member
           on target_member.conversation_id = m.conversation_id
          and target_member.user_id <> m.sender_id
         join ritim.users target on target.id = target_member.user_id
         where coalesce(encode(sender.legacy_account_id_hash, 'hex'), sender.public_id::text)
                 in (${placeholders})
           and coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text)
                 in (${placeholders})
           and not exists (
             select 1 from ritim.blocks block
             where (block.blocker_id = sender.id and block.blocked_id = target.id)
                or (block.blocker_id = target.id and block.blocked_id = sender.id)
           )
           and m.deleted_at is null
       ) ranked
       where message_rank <= 100
       order by sent_at asc, id asc`,
      keys,
    )

    return result.rows.flatMap((row) => {
      const senderId = accountByKey.get(row.sender_key)
      const targetId = accountByKey.get(row.target_key)
      if (!senderId || !targetId) return []
      return [{
        id: row.public_id,
        senderId,
        targetId,
        text: row.body,
        sentAt: row.sent_at.getTime(),
      }]
    })
  }

  async function saveReaction(value: StoredReaction) {
    await inTransaction(pool, async (client) => {
      const actorId = await findUserId(client, value.actorId)
      const targetId = await findUserId(client, value.targetId)
      if (!actorId || !targetId || actorId === targetId) throw new Error('Tepki kullanıcıları bulunamadı.')
      if (!await usersCanInteract(client, actorId, targetId)) throw new Error('Tepki gönderimi engellendi.')
      await client.query(
        `insert into ritim.reactions (actor_id, target_id, reaction)
         values ($1, $2, $3)`,
        [actorId, targetId, value.reaction],
      )
    })
  }

  async function loadReactions(accountIds: string[]) {
    if (!accountIds.length) return new Map<string, { count: number; lastReaction?: string }>()
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const placeholders = keys.map((_value, index) => `$${index + 1}`).join(', ')
    const result = await pool.query<{
      target_key: string
      reaction_count: string
      last_reaction: string
    }>(
      `select
         coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text) as target_key,
         count(reaction.id) as reaction_count,
         (array_agg(reaction.reaction order by reaction.created_at desc, reaction.id desc))[1] as last_reaction
       from ritim.reactions reaction
       join ritim.users target on target.id = reaction.target_id
       where coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text)
             in (${placeholders})
       group by target.id`,
      keys,
    )
    const reactions = new Map<string, { count: number; lastReaction?: string }>()
    for (const row of result.rows) {
      const targetId = accountByKey.get(row.target_key)
      if (targetId) {
        reactions.set(targetId, {
          count: Math.min(999, Number(row.reaction_count) || 0),
          lastReaction: row.last_reaction || undefined,
        })
      }
    }
    return reactions
  }

  async function loadAccess(accountIds: string[]) {
    const access = new Map<string, Map<string, AccessRule>>()
    if (!accountIds.length) return access
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const placeholders = keys.map((_value, index) => `$${index + 1}`).join(', ')
    const users = await pool.query<{
      id: string
      account_key: string
      profile_visibility: Visibility
      listening_visibility: Visibility
    }>(
      `select id,
              coalesce(encode(legacy_account_id_hash, 'hex'), public_id::text) as account_key,
              profile_visibility,
              listening_visibility
       from ritim.users
       where coalesce(encode(legacy_account_id_hash, 'hex'), public_id::text)
             in (${placeholders})`,
      keys,
    )
    const accountByDatabaseId = new Map<string, string>()
    const preferences = new Map<string, PrivacyPreferences>()
    for (const user of users.rows) {
      const accountId = accountByKey.get(user.account_key)
      if (!accountId) continue
      accountByDatabaseId.set(user.id, accountId)
      preferences.set(accountId, {
        profileVisibility: user.profile_visibility,
        listeningVisibility: user.listening_visibility,
      })
    }
    const databaseIds = [...accountByDatabaseId.keys()]
    if (!databaseIds.length) return access
    const relationships = await pool.query<{ left_id: string; right_id: string; kind: 'block' | 'contact' }>(
      `select blocker_id as left_id, blocked_id as right_id, 'block'::text as kind
       from ritim.blocks
       where blocker_id = any($1::bigint[]) and blocked_id = any($1::bigint[])
       union all
       select left_member.user_id as left_id, right_member.user_id as right_id, 'contact'::text as kind
       from ritim.conversation_members left_member
       join ritim.conversation_members right_member
         on right_member.conversation_id = left_member.conversation_id
        and right_member.user_id <> left_member.user_id
       where left_member.user_id = any($1::bigint[]) and right_member.user_id = any($1::bigint[])`,
      [databaseIds],
    )
    const blocked = new Set<string>()
    const contacts = new Set<string>()
    for (const relationship of relationships.rows) {
      const left = accountByDatabaseId.get(relationship.left_id)
      const right = accountByDatabaseId.get(relationship.right_id)
      if (!left || !right) continue
      const pair = [left, right].sort().join(':')
      if (relationship.kind === 'block') blocked.add(pair)
      else contacts.add(pair)
    }
    for (const viewerId of accountIds) {
      const rules = new Map<string, AccessRule>()
      for (const targetId of accountIds) {
        if (viewerId === targetId) {
          rules.set(targetId, { profile: true, listening: true })
          continue
        }
        const pair = [viewerId, targetId].sort().join(':')
        const targetPreferences = preferences.get(targetId) || {
          profileVisibility: 'everyone',
          listeningVisibility: 'everyone',
        }
        const isContact = contacts.has(pair)
        const isBlocked = blocked.has(pair)
        rules.set(targetId, {
          profile: !isBlocked && (
            targetPreferences.profileVisibility === 'everyone'
            || (targetPreferences.profileVisibility === 'contacts' && isContact)
          ),
          listening: !isBlocked && (
            targetPreferences.listeningVisibility === 'everyone'
            || (targetPreferences.listeningVisibility === 'contacts' && isContact)
          ),
        })
      }
      access.set(viewerId, rules)
    }
    return access
  }

  async function loadPrivacy(accountId: string): Promise<PrivacyPreferences> {
    const key = accountKey(accountId)
    const result = await pool.query<{
      profile_visibility: Visibility
      listening_visibility: Visibility
    }>(
      `select profile_visibility, listening_visibility
       from ritim.users
       where coalesce(encode(legacy_account_id_hash, 'hex'), public_id::text) = $1`,
      [key],
    )
    return {
      profileVisibility: result.rows[0]?.profile_visibility || 'everyone',
      listeningVisibility: result.rows[0]?.listening_visibility || 'everyone',
    }
  }

  async function updatePrivacy(accountId: string, preferences: PrivacyPreferences) {
    const result = UUID_PATTERN.test(accountId)
      ? await pool.query(
          `update ritim.users set profile_visibility = $2, listening_visibility = $3
           where public_id = $1`,
          [accountId, preferences.profileVisibility, preferences.listeningVisibility],
        )
      : await pool.query(
          `update ritim.users set profile_visibility = $2, listening_visibility = $3
           where legacy_account_id_hash = $1`,
          [sha256(accountId), preferences.profileVisibility, preferences.listeningVisibility],
        )
    if (!result.rowCount) throw new Error('Gizlilik ayarı için kullanıcı bulunamadı.')
  }

  async function toggleBlock(blockerAccountId: string, blockedAccountId: string) {
    const blocked = await inTransaction(pool, async (client) => {
      const blockerId = await findUserId(client, blockerAccountId)
      const blockedId = await findUserId(client, blockedAccountId)
      if (!blockerId || !blockedId || blockerId === blockedId) throw new Error('Engelleme kullanıcıları bulunamadı.')
      const removed = await client.query(
        'delete from ritim.blocks where blocker_id = $1 and blocked_id = $2',
        [blockerId, blockedId],
      )
      if (removed.rowCount) return false
      await client.query(
        `insert into ritim.blocks (blocker_id, blocked_id)
         values ($1, $2)
         on conflict (blocker_id, blocked_id) do nothing`,
        [blockerId, blockedId],
      )
      return true
    })
    if (blocked) {
      const blockerListeningKey = `ritim:listening:${hashHex(blockerAccountId)}`
      const blockedListeningKey = `ritim:listening:${hashHex(blockedAccountId)}`
      const [blockerTarget, blockedTarget] = await Promise.all([
        redis.get(blockerListeningKey),
        redis.get(blockedListeningKey),
      ])
      const operations = []
      if (blockerTarget === hashHex(blockedAccountId)) operations.push(redis.del(blockerListeningKey))
      if (blockedTarget === hashHex(blockerAccountId)) operations.push(redis.del(blockedListeningKey))
      await Promise.all(operations)
    }
    return blocked
  }

  async function toggleRoom(ownerAccountId: string, title: string, cover: number) {
    return inTransaction(pool, async (client) => {
      const ownerId = await findUserId(client, ownerAccountId)
      if (!ownerId) throw new Error('Oda sahibi bulunamadı.')
      await client.query('select pg_advisory_xact_lock($1)', [ownerId])
      const ended = await client.query<{ id: string }>(
        `update ritim.listening_rooms
         set ended_at = now()
         where owner_id = $1 and ended_at is null
         returning id`,
        [ownerId],
      )
      if (ended.rowCount) {
        await client.query(
          `update ritim.room_members
           set left_at = now()
           where room_id = any($1::bigint[]) and left_at is null`,
          [ended.rows.map((row) => row.id)],
        )
        return false
      }

      const roomResult = await client.query<{ id: string }>(
        `insert into ritim.listening_rooms (owner_id, title, cover)
         values ($1, $2, $3)
         returning id`,
        [ownerId, title, cover],
      )
      await client.query(
        `insert into ritim.room_members (room_id, user_id, role)
         values ($1, $2, 'owner')`,
        [roomResult.rows[0].id, ownerId],
      )
      return true
    })
  }

  async function loadRooms(accountIds: string[]): Promise<StoredRoom[]> {
    if (!accountIds.length) return []
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const placeholders = keys.map((_value, index) => `$${index + 1}`).join(', ')
    const result = await pool.query<{
      public_id: string
      owner_key: string
      title: string
      cover: number
      member_count: string
      member_initials: string[]
    }>(
       `select
         room.public_id,
         coalesce(encode(owner.legacy_account_id_hash, 'hex'), owner.public_id::text) as owner_key,
         room.title,
         room.cover,
         count(member.user_id) filter (where member.left_at is null) as member_count,
         coalesce(
           array_agg(member_user.initials order by member.joined_at)
             filter (where member.left_at is null),
           '{}'
         ) as member_initials
       from ritim.listening_rooms room
       join ritim.users owner on owner.id = room.owner_id
       left join ritim.room_members member on member.room_id = room.id
       left join ritim.users member_user on member_user.id = member.user_id
       where room.ended_at is null
         and coalesce(encode(owner.legacy_account_id_hash, 'hex'), owner.public_id::text)
               in (${placeholders})
       group by room.id, owner.legacy_account_id_hash, owner.public_id
       order by room.started_at asc`,
      keys,
    )
    return result.rows.flatMap((row) => {
      const ownerId = accountByKey.get(row.owner_key)
      if (!ownerId) return []
      return [{
        id: `room-${row.public_id}`,
        ownerId,
        title: row.title,
        cover: Number(row.cover) || 0,
        memberCount: Number(row.member_count) || 0,
        memberInitials: row.member_initials.slice(0, 4),
      }]
    })
  }

  async function toggleListening(listenerAccountId: string, targetAccountId: string) {
    const listenerHash = hashHex(listenerAccountId)
    const targetHash = hashHex(targetAccountId)
    const listeningKey = `ritim:listening:${listenerHash}`
    const currentTarget = await redis.get(listeningKey)
    const stopping = currentTarget === targetHash

    await inTransaction(pool, async (client) => {
      const listenerId = await findUserId(client, listenerAccountId)
      const targetId = await findUserId(client, targetAccountId)
      if (!listenerId || !targetId || listenerId === targetId) return
      if (!await usersCanInteract(client, listenerId, targetId)) return
      const visibility = await client.query<{ listening_visibility: Visibility; is_contact: boolean }>(
        `select target.listening_visibility,
                exists (
                  select 1
                  from ritim.conversation_members listener_member
                  join ritim.conversation_members target_member
                    on target_member.conversation_id = listener_member.conversation_id
                   and target_member.user_id = $2
                  where listener_member.user_id = $1
                ) as is_contact
         from ritim.users target
         where target.id = $2`,
        [listenerId, targetId],
      )
      const targetVisibility = visibility.rows[0]
      if (
        targetVisibility?.listening_visibility === 'hidden'
        || (targetVisibility?.listening_visibility === 'contacts' && !targetVisibility.is_contact)
      ) return

      await client.query(
        `update ritim.room_members member
         set left_at = now()
         from ritim.listening_rooms room
         where member.room_id = room.id
           and member.user_id = $1
           and member.role = 'listener'
           and member.left_at is null`,
        [listenerId],
      )
      if (stopping) return

      const roomResult = await client.query<{ id: string }>(
        `select id from ritim.listening_rooms
         where owner_id = $1 and ended_at is null`,
        [targetId],
      )
      const roomId = roomResult.rows[0]?.id
      if (!roomId) return
      await client.query(
        `insert into ritim.room_members (room_id, user_id, role)
         values ($1, $2, 'listener')
         on conflict (room_id, user_id) do update set
           role = 'listener',
           joined_at = now(),
           left_at = null`,
        [roomId, listenerId],
      )
    })

    if (stopping) await redis.del(listeningKey)
    else await redis.set(listeningKey, targetHash, { EX: LISTENING_TTL_SECONDS })
  }

  async function loadListening(accountIds: string[]) {
    const accountByHash = new Map(accountIds.map((accountId) => [hashHex(accountId), accountId]))
    const hashes = [...accountByHash.keys()]
    if (!hashes.length) return new Map<string, string>()
    const values = await redis.mGet(hashes.map((hash) => `ritim:listening:${hash}`))
    const listening = new Map<string, string>()
    hashes.forEach((listenerHash, index) => {
      const listenerId = accountByHash.get(listenerHash)
      const targetId = values[index] ? accountByHash.get(values[index] as string) : undefined
      if (listenerId && targetId) listening.set(listenerId, targetId)
    })
    return listening
  }

  async function clearListening(accountId: string) {
    await redis.del(`ritim:listening:${hashHex(accountId)}`)
  }

  return {
    durable: true,
    upsertProfile,
    touchPresence,
    removePresence,
    saveMessage,
    loadMessages,
    saveReaction,
    loadReactions,
    loadAccess,
    loadPrivacy,
    updatePrivacy,
    toggleBlock,
    toggleRoom,
    loadRooms,
    toggleListening,
    loadListening,
    clearListening,
  }
}
