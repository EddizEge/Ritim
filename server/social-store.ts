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

const PRESENCE_TTL_SECONDS = 60
const PRESENCE_SET_TTL_SECONDS = 120
const LISTENING_TTL_SECONDS = 120

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest()
}

function hashHex(value: string) {
  return sha256(value).toString('hex')
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
  const result = await client.query<{ id: string }>(
    'select id from ritim.users where legacy_account_id_hash = $1',
    [sha256(accountId)],
  )
  return result.rows[0]?.id
}

export function createDurableSocialStore(pool: Pool, redis: RedisClient) {
  async function upsertProfile(accountId: string, deviceId: string, profile: SocialProfile) {
    const accountHash = sha256(accountId)
    const deviceHash = sha256(deviceId)

    await inTransaction(pool, async (client) => {
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
    const accountByHash = new Map(accountIds.map((accountId) => [hashHex(accountId), accountId]))
    const hashes = [...accountByHash.keys()].map((value) => Buffer.from(value, 'hex'))
    const placeholders = hashes.map((_value, index) => `$${index + 1}`).join(', ')
    const result = await pool.query<{
      public_id: string
      sender_hash: string
      target_hash: string
      body: string
      sent_at: Date
    }>(
      `select public_id, sender_hash, target_hash, body, sent_at
       from (
         select
           m.public_id,
           encode(sender.legacy_account_id_hash, 'hex') as sender_hash,
           encode(target.legacy_account_id_hash, 'hex') as target_hash,
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
         where sender.legacy_account_id_hash in (${placeholders})
           and target.legacy_account_id_hash in (${placeholders})
           and m.deleted_at is null
       ) ranked
       where message_rank <= 100
       order by sent_at asc, id asc`,
      hashes,
    )

    return result.rows.flatMap((row) => {
      const senderId = accountByHash.get(row.sender_hash)
      const targetId = accountByHash.get(row.target_hash)
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
    const accountByHash = new Map(accountIds.map((accountId) => [hashHex(accountId), accountId]))
    const hashes = [...accountByHash.keys()].map((value) => Buffer.from(value, 'hex'))
    const placeholders = hashes.map((_value, index) => `$${index + 1}`).join(', ')
    const result = await pool.query<{
      public_id: string
      owner_hash: string
      title: string
      cover: number
      member_count: string
      member_initials: string[]
    }>(
      `select
         room.public_id,
         encode(owner.legacy_account_id_hash, 'hex') as owner_hash,
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
         and owner.legacy_account_id_hash in (${placeholders})
       group by room.id, owner.legacy_account_id_hash
       order by room.started_at asc`,
      hashes,
    )
    return result.rows.flatMap((row) => {
      const ownerId = accountByHash.get(row.owner_hash)
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
    toggleRoom,
    loadRooms,
    toggleListening,
    loadListening,
    clearListening,
  }
}
