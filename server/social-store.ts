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
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
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
  reactions: Array<{
    actorId: string
    reaction: '♥' | '🔥' | '😂' | '👍'
  }>
}

type StoredMessageRequest = {
  userId: string
  direction: 'incoming' | 'outgoing'
  preview: string
  sentAt: number
}

type StoredNotification = {
  id: string
  kind: 'message_request' | 'message' | 'reaction'
  actorId?: string
  messageId?: string
  body: string
  createdAt: number
  read: boolean
}

type NotificationPreferences = {
  messagesEnabled: boolean
  reactionsEnabled: boolean
  deviceEnabled: boolean
}

type StoredSocialUser = {
  id: string
  displayName: string
  handle: string
  initials: string
  avatarUrl?: string
  avatarTone: number
  presence: 'offline'
  currentTrack?: undefined
  reactionCount: number
  lastReaction?: undefined
}

type ReportSummary = {
  total: number
  recent: Array<{
    targetUserId: string
    displayName: string
    reason: string
    createdAt: number
    status: 'received'
  }>
}

type StoredRoom = {
  id: string
  ownerId: string
  title: string
  cover: number
  memberCount: number
  memberInitials: string[]
  memberIds: string[]
}

type StoredRoomMessage = {
  id: string
  roomId: string
  senderId: string
  text: string
  sentAt: number
}

type RoomPlayback = {
  roomId: string
  ownerId: string
  videoId: string
  playbackPositionMs: number
  playbackState: 'playing' | 'paused'
  playbackRevision: number
  serverTimeMs?: number
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
const MAX_ROOM_MEMBERS = 8
// Each connected account keeps its own newest notifications; one busy account
// must not push the others out of the shared snapshot query.
export const NOTIFICATION_LIMIT_PER_ACCOUNT = 100
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

function redisKeyFromDatabaseAccountKey(value: string) {
  return UUID_PATTERN.test(value) ? hashHex(value) : value
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
                 from ritim.message_requests request
                 where request.status = 'accepted'
                   and (
                     (request.requester_id = $1 and request.recipient_id = $2)
                     or (request.requester_id = $2 and request.recipient_id = $1)
                   )
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
    return inTransaction(pool, async (client) => {
      const senderId = await findUserId(client, message.senderId)
      const targetId = await findUserId(client, message.targetId)
      if (!senderId || !targetId || senderId === targetId) throw new Error('Mesaj kullanıcıları bulunamadı.')
      const duplicate = await client.query(
        `select 1 from ritim.messages
         where sender_id = $1 and client_message_id = $2`,
        [senderId, message.id],
      )
      if (duplicate.rowCount) return { duplicate: true }
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
      const requestResult = await client.query<{
        requester_id: string
        recipient_id: string
        status: 'pending' | 'accepted' | 'rejected'
      }>(
        `select requester_id, recipient_id, status
         from ritim.message_requests
         where conversation_id = $1
         for update`,
        [conversationId],
      )
      const request = requestResult.rows[0]
      let notificationKind: 'message_request' | 'message' = 'message'
      if (!request) {
        await client.query(
          `insert into ritim.message_requests (
             conversation_id, requester_id, recipient_id, status
           ) values ($1, $2, $3, 'pending')`,
          [conversationId, senderId, targetId],
        )
        notificationKind = 'message_request'
      } else if (request.status === 'pending') {
        throw new Error('Mesaj isteği yanıt bekliyor.')
      } else if (request.status === 'rejected') {
        if (String(request.recipient_id) !== String(senderId)) {
          throw new Error('Mesaj isteği reddedildi.')
        }
        await client.query(
          `update ritim.message_requests
           set requester_id = $2,
               recipient_id = $3,
               status = 'pending',
               created_at = now(),
               responded_at = null
           where conversation_id = $1`,
          [conversationId, senderId, targetId],
        )
        notificationKind = 'message_request'
      }
      const inserted = await client.query<{ id: string }>(
        `insert into ritim.messages (
          public_id, conversation_id, sender_id, client_message_id, body, sent_at
        ) values ($1, $2, $3, $1, $4, $5)
        on conflict (sender_id, client_message_id) do nothing
        returning id`,
        [message.id, conversationId, senderId, message.text, new Date(message.sentAt)],
      )
      const messageId = inserted.rows[0]?.id
      if (messageId) {
        await client.query(
          `insert into ritim.social_notifications (
             recipient_id, actor_id, kind, message_id, body
           )
           select $1, $2, $3, $4, $5
           where coalesce((
             select preferences.messages_enabled
             from ritim.notification_preferences preferences
             where preferences.user_id = $1
           ), true)
             and not exists (
               select 1
               from ritim.conversation_members member
               where member.conversation_id = $6
                 and member.user_id = $1
                 and member.muted_until > now()
             )
           on conflict do nothing`,
          [targetId, senderId, notificationKind, messageId, message.text, conversationId],
        )
      }
      return { duplicate: !messageId }
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
      reactions: Array<{ actor_key: string; reaction: '♥' | '🔥' | '😂' | '👍' }>
    }>(
      `select public_id, sender_key, target_key, body, sent_at, reactions
       from (
         select
           m.public_id,
           coalesce(encode(sender.legacy_account_id_hash, 'hex'), sender.public_id::text) as sender_key,
           coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text) as target_key,
           m.body,
           m.sent_at,
           m.id,
           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'actor_key', coalesce(encode(actor.legacy_account_id_hash, 'hex'), actor.public_id::text),
                 'reaction', message_reaction.reaction
               )
               order by message_reaction.created_at asc
             )
             from ritim.message_reactions message_reaction
             join ritim.users actor on actor.id = message_reaction.actor_id
             where message_reaction.message_id = m.id
           ), '[]'::jsonb) as reactions,
           row_number() over (
             partition by m.conversation_id order by m.sent_at desc, m.id desc
           ) as message_rank
         from ritim.messages m
         join ritim.users sender on sender.id = m.sender_id
         join ritim.conversation_members target_member
           on target_member.conversation_id = m.conversation_id
          and target_member.user_id <> m.sender_id
         join ritim.users target on target.id = target_member.user_id
         join ritim.message_requests request
           on request.conversation_id = m.conversation_id
          and request.status <> 'rejected'
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
        reactions: row.reactions.flatMap((reaction) => {
          const actorId = accountByKey.get(reaction.actor_key)
          return actorId ? [{ actorId, reaction: reaction.reaction }] : []
        }),
      }]
    })
  }

  async function saveMessageReaction(
    actorAccountId: string,
    peerAccountId: string,
    messagePublicId: string,
    reaction: '♥' | '🔥' | '😂' | '👍',
  ) {
    await inTransaction(pool, async (client) => {
      const actorId = await findUserId(client, actorAccountId)
      const peerId = await findUserId(client, peerAccountId)
      if (!actorId || !peerId || actorId === peerId) throw new Error('Tepki kullanıcıları bulunamadı.')
      const message = await client.query<{
        id: string
        sender_id: string
        body: string
        conversation_id: string
      }>(
        `select message.id, message.sender_id, message.body, message.conversation_id
         from ritim.messages message
         join ritim.message_requests request
           on request.conversation_id = message.conversation_id
          and request.status = 'accepted'
         where message.public_id = $1
           and message.deleted_at is null
           and not exists (
             select 1 from ritim.blocks block
             where (block.blocker_id = $2 and block.blocked_id = $3)
                or (block.blocker_id = $3 and block.blocked_id = $2)
           )
           and exists (
             select 1
             from ritim.conversation_members actor_member
             where actor_member.conversation_id = message.conversation_id
               and actor_member.user_id = $2
           )
           and exists (
             select 1
             from ritim.conversation_members peer_member
             where peer_member.conversation_id = message.conversation_id
               and peer_member.user_id = $3
           )
         for update`,
        [messagePublicId, actorId, peerId],
      )
      const selected = message.rows[0]
      if (!selected) throw new Error('Tepki verilecek mesaj bulunamadı.')
      const existing = await client.query<{ reaction: string }>(
        `select reaction from ritim.message_reactions
         where message_id = $1 and actor_id = $2`,
        [selected.id, actorId],
      )
      if (existing.rows[0]?.reaction === reaction) {
        await client.query(
          'delete from ritim.message_reactions where message_id = $1 and actor_id = $2',
          [selected.id, actorId],
        )
        return
      }
      await client.query(
        `insert into ritim.message_reactions (message_id, actor_id, reaction)
         values ($1, $2, $3)
         on conflict (message_id, actor_id) do update set
           reaction = excluded.reaction,
           created_at = now()`,
        [selected.id, actorId, reaction],
      )
      if (String(selected.sender_id) !== String(actorId)) {
        await client.query(
          `insert into ritim.social_notifications (
             recipient_id, actor_id, kind, message_id, body
           )
           select $1, $2, 'reaction', $3, $4
           where coalesce((
             select preferences.reactions_enabled
             from ritim.notification_preferences preferences
             where preferences.user_id = $1
           ), true)
             and not exists (
               select 1
               from ritim.conversation_members member
               where member.conversation_id = $5
                 and member.user_id = $1
                 and member.muted_until > now()
             )
           on conflict (recipient_id, actor_id, kind, message_id)
             where message_id is not null
           do update set body = excluded.body, created_at = now(), read_at = null`,
          [selected.sender_id, actorId, selected.id, reaction, selected.conversation_id],
        )
      }
    })
  }

  async function loadNotifications(accountIds: string[]) {
    const notifications = new Map<string, StoredNotification[]>()
    for (const accountId of accountIds) notifications.set(accountId, [])
    if (!accountIds.length) return notifications
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const result = await pool.query<{
      public_id: string
      recipient_key: string
      actor_key: string | null
      kind: StoredNotification['kind']
      message_public_id: string | null
      body: string
      created_at: Date
      read_at: Date | null
    }>(
      `select public_id, recipient_key, actor_key, kind, message_public_id, body, created_at, read_at
       from (
         select
           notification.public_id,
           coalesce(encode(recipient.legacy_account_id_hash, 'hex'), recipient.public_id::text) as recipient_key,
           coalesce(encode(actor.legacy_account_id_hash, 'hex'), actor.public_id::text) as actor_key,
           notification.kind,
           message.public_id as message_public_id,
           notification.body,
           notification.created_at,
           notification.read_at,
           notification.id,
           row_number() over (
             partition by notification.recipient_id
             order by notification.created_at desc, notification.id desc
           ) as notification_rank
         from ritim.social_notifications notification
         join ritim.users recipient on recipient.id = notification.recipient_id
         left join ritim.users actor on actor.id = notification.actor_id
         left join ritim.messages message on message.id = notification.message_id
         where coalesce(encode(recipient.legacy_account_id_hash, 'hex'), recipient.public_id::text) = any($1::text[])
       ) ranked
       where notification_rank <= $2
       order by recipient_key, created_at desc, id desc`,
      [[...accountByKey.keys()], NOTIFICATION_LIMIT_PER_ACCOUNT],
    )
    for (const row of result.rows) {
      const recipientId = accountByKey.get(row.recipient_key)
      if (!recipientId) continue
      notifications.get(recipientId)?.push({
        id: row.public_id,
        kind: row.kind,
        actorId: row.actor_key ? accountByKey.get(row.actor_key) : undefined,
        messageId: row.message_public_id || undefined,
        body: row.body,
        createdAt: row.created_at.getTime(),
        read: Boolean(row.read_at),
      })
    }
    return notifications
  }

  async function markNotificationsRead(accountId: string) {
    const key = accountKey(accountId)
    await pool.query(
      `update ritim.social_notifications notification
       set read_at = now()
       from ritim.users recipient
       where recipient.id = notification.recipient_id
         and coalesce(encode(recipient.legacy_account_id_hash, 'hex'), recipient.public_id::text) = $1
         and notification.read_at is null`,
      [key],
    )
  }

  async function loadNotificationPreferences(accountIds: string[]) {
    const selected = new Map<string, NotificationPreferences>()
    for (const accountId of accountIds) {
      selected.set(accountId, {
        messagesEnabled: true,
        reactionsEnabled: true,
        deviceEnabled: false,
      })
    }
    if (!accountIds.length) return selected
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const result = await pool.query<{
      account_key: string
      messages_enabled: boolean
      reactions_enabled: boolean
    }>(
      `select
         coalesce(encode(app_user.legacy_account_id_hash, 'hex'), app_user.public_id::text) as account_key,
         preferences.messages_enabled,
         preferences.reactions_enabled
       from ritim.notification_preferences preferences
       join ritim.users app_user on app_user.id = preferences.user_id
       where coalesce(encode(app_user.legacy_account_id_hash, 'hex'), app_user.public_id::text) = any($1::text[])`,
      [[...accountByKey.keys()]],
    )
    for (const row of result.rows) {
      const accountId = accountByKey.get(row.account_key)
      if (!accountId) continue
      selected.set(accountId, {
        messagesEnabled: row.messages_enabled,
        reactionsEnabled: row.reactions_enabled,
        deviceEnabled: false,
      })
    }
    return selected
  }

  async function updateNotificationPreferences(accountId: string, preferences: NotificationPreferences) {
    await inTransaction(pool, async (client) => {
      const userId = await findUserId(client, accountId)
      if (!userId) throw new Error('Bildirim ayarı için kullanıcı bulunamadı.')
      await client.query(
        `insert into ritim.notification_preferences (
           user_id, messages_enabled, reactions_enabled
         ) values ($1, $2, $3)
         on conflict (user_id) do update set
           messages_enabled = excluded.messages_enabled,
           reactions_enabled = excluded.reactions_enabled,
           updated_at = now()`,
        [
          userId,
          preferences.messagesEnabled,
          preferences.reactionsEnabled,
        ],
      )
    })
  }

  async function loadModerationState(accountIds: string[]) {
    const muted = new Map<string, Set<string>>()
    const blocked = new Map<string, Set<string>>()
    const mutedUsers = new Map<string, StoredSocialUser[]>()
    const blockedUsers = new Map<string, StoredSocialUser[]>()
    for (const accountId of accountIds) {
      muted.set(accountId, new Set())
      blocked.set(accountId, new Set())
      mutedUsers.set(accountId, [])
      blockedUsers.set(accountId, [])
    }
    if (!accountIds.length) return { muted, blocked, mutedUsers, blockedUsers }
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const result = await pool.query<{
      viewer_key: string
      target_key: string
      target_public_id: string
      target_display_name: string
      target_handle: string
      target_initials: string
      target_avatar_url: string | null
      target_avatar_tone: number
      kind: 'mute' | 'block'
    }>(
      `select
         coalesce(encode(viewer.legacy_account_id_hash, 'hex'), viewer.public_id::text) as viewer_key,
         coalesce(encode(target.legacy_account_id_hash, 'hex'), target.public_id::text) as target_key,
         target.public_id::text as target_public_id,
         target.display_name as target_display_name,
         target.handle as target_handle,
         target.initials as target_initials,
         target.avatar_url as target_avatar_url,
         target.avatar_tone as target_avatar_tone,
         'mute'::text as kind
       from ritim.conversation_members viewer_member
       join ritim.users viewer on viewer.id = viewer_member.user_id
       join ritim.conversation_members target_member
         on target_member.conversation_id = viewer_member.conversation_id
        and target_member.user_id <> viewer_member.user_id
       join ritim.users target on target.id = target_member.user_id
       join ritim.message_requests request
         on request.conversation_id = viewer_member.conversation_id
        and request.status = 'accepted'
       where viewer_member.muted_until > now()
         and coalesce(encode(viewer.legacy_account_id_hash, 'hex'), viewer.public_id::text) = any($1::text[])
       union all
       select
         coalesce(encode(blocker.legacy_account_id_hash, 'hex'), blocker.public_id::text) as viewer_key,
         coalesce(encode(blocked_user.legacy_account_id_hash, 'hex'), blocked_user.public_id::text) as target_key,
         blocked_user.public_id::text as target_public_id,
         blocked_user.display_name as target_display_name,
         blocked_user.handle as target_handle,
         blocked_user.initials as target_initials,
         blocked_user.avatar_url as target_avatar_url,
         blocked_user.avatar_tone as target_avatar_tone,
         'block'::text as kind
       from ritim.blocks block
       join ritim.users blocker on blocker.id = block.blocker_id
       join ritim.users blocked_user on blocked_user.id = block.blocked_id
       where coalesce(encode(blocker.legacy_account_id_hash, 'hex'), blocker.public_id::text) = any($1::text[])
       order by kind, target_display_name, target_public_id`,
      [keys],
    )
    for (const row of result.rows) {
      const viewerId = accountByKey.get(row.viewer_key)
      const targetId = accountByKey.get(row.target_key) || row.target_public_id
      if (!viewerId || !targetId) continue
      const user: StoredSocialUser = {
        id: targetId,
        displayName: row.target_display_name,
        handle: row.target_handle,
        initials: row.target_initials,
        avatarUrl: row.target_avatar_url || undefined,
        avatarTone: Number(row.target_avatar_tone) || 0,
        presence: 'offline',
        currentTrack: undefined,
        reactionCount: 0,
        lastReaction: undefined,
      }
      if (row.kind === 'mute') {
        muted.get(viewerId)?.add(targetId)
        mutedUsers.get(viewerId)?.push(user)
      } else {
        blocked.get(viewerId)?.add(targetId)
        blockedUsers.get(viewerId)?.push(user)
      }
    }
    return { muted, blocked, mutedUsers, blockedUsers }
  }

  async function toggleMute(accountId: string, peerAccountId: string) {
    await inTransaction(pool, async (client) => {
      const viewerId = await findUserId(client, accountId)
      const peerId = await findUserId(client, peerAccountId)
      if (!viewerId || !peerId || viewerId === peerId) throw new Error('Sessize alma kullanıcıları bulunamadı.')
      const updated = await client.query(
        `update ritim.conversation_members viewer_member
         set muted_until = case
           when viewer_member.muted_until > now() then null
           else now() + interval '100 years'
         end
         where viewer_member.user_id = $1
           and exists (
             select 1
             from ritim.conversation_members peer_member
             join ritim.message_requests request
               on request.conversation_id = peer_member.conversation_id
              and request.status = 'accepted'
             where peer_member.conversation_id = viewer_member.conversation_id
               and peer_member.user_id = $2
           )`,
        [viewerId, peerId],
      )
      if (!updated.rowCount) throw new Error('Sessize alınacak kabul edilmiş konuşma bulunamadı.')
    })
  }

  async function saveReport(
    reporterAccountId: string,
    targetAccountId: string,
    reason: string,
    detail?: string,
    messagePublicId?: string,
  ) {
    await inTransaction(pool, async (client) => {
      const reporterId = await findUserId(client, reporterAccountId)
      const targetId = await findUserId(client, targetAccountId)
      if (!reporterId || !targetId || reporterId === targetId) throw new Error('Şikâyet kullanıcıları bulunamadı.')
      let messageId
      if (messagePublicId) {
        const message = await client.query<{ id: string }>(
          `select message.id
           from ritim.messages message
           where message.public_id = $1
             and message.sender_id = $2
             and exists (
               select 1 from ritim.conversation_members reporter_member
               where reporter_member.conversation_id = message.conversation_id
                 and reporter_member.user_id = $3
             )`,
          [messagePublicId, targetId, reporterId],
        )
        messageId = message.rows[0]?.id
      }
      await client.query(
        `insert into ritim.reports (
           reporter_id, reported_user_id, message_id, reason, detail
         ) values ($1, $2, $3, $4, $5)`,
        [reporterId, targetId, messageId || null, reason, detail || null],
      )
    })
  }

  async function loadReportSummaries(accountIds: string[]) {
    const summaries = new Map<string, ReportSummary>()
    for (const accountId of accountIds) summaries.set(accountId, { total: 0, recent: [] })
    if (!accountIds.length) return summaries
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const result = await pool.query<{
      reporter_key: string
      target_user_id: string
      display_name: string
      reason: string
      created_at: Date
      total: string
    }>(
      `with report_rows as (
         select
           coalesce(encode(reporter.legacy_account_id_hash, 'hex'), reporter.public_id::text) as reporter_key,
           reported_user.public_id::text as target_user_id,
           reported_user.display_name,
           report.reason,
           report.created_at,
           count(*) over (partition by report.reporter_id) as total,
           row_number() over (
             partition by report.reporter_id
             order by report.created_at desc, report.reported_user_id
           ) as recent_rank
         from ritim.reports report
         join ritim.users reporter on reporter.id = report.reporter_id
         join ritim.users reported_user on reported_user.id = report.reported_user_id
         where coalesce(encode(reporter.legacy_account_id_hash, 'hex'), reporter.public_id::text) = any($1::text[])
       )
       select reporter_key, target_user_id, display_name, reason, created_at, total
       from report_rows
       where recent_rank <= 20
       order by reporter_key, created_at desc, target_user_id`,
      [[...accountByKey.keys()]],
    )
    for (const row of result.rows) {
      const reporterId = accountByKey.get(row.reporter_key)
      if (!reporterId) continue
      const summary = summaries.get(reporterId)
      if (!summary) continue
      summary.total = Math.max(summary.total, Number(row.total) || 0)
      summary.recent.push({
        targetUserId: row.target_user_id,
        displayName: row.display_name,
        reason: row.reason,
        createdAt: row.created_at.getTime(),
        status: 'received',
      })
    }
    return summaries
  }

  async function loadUnreadCounts(accountIds: string[]) {
    const unread = new Map<string, Map<string, number>>()
    for (const accountId of accountIds) unread.set(accountId, new Map())
    if (accountIds.length < 2) return unread

    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const result = await pool.query<{
      viewer_key: string
      peer_key: string
      unread_count: string
    }>(
      `select
         coalesce(encode(viewer.legacy_account_id_hash, 'hex'), viewer.public_id::text) as viewer_key,
         coalesce(encode(peer.legacy_account_id_hash, 'hex'), peer.public_id::text) as peer_key,
         count(message.id) as unread_count
       from ritim.conversation_members viewer_member
       join ritim.users viewer on viewer.id = viewer_member.user_id
       join ritim.conversation_members peer_member
         on peer_member.conversation_id = viewer_member.conversation_id
        and peer_member.user_id <> viewer_member.user_id
       join ritim.users peer on peer.id = peer_member.user_id
       join ritim.message_requests request
         on request.conversation_id = viewer_member.conversation_id
        and request.status = 'accepted'
       join ritim.messages message
         on message.conversation_id = viewer_member.conversation_id
        and message.sender_id = peer_member.user_id
        and message.id > coalesce(viewer_member.last_read_message_id, 0)
        and message.deleted_at is null
       where coalesce(encode(viewer.legacy_account_id_hash, 'hex'), viewer.public_id::text) = any($1::text[])
         and coalesce(encode(peer.legacy_account_id_hash, 'hex'), peer.public_id::text) = any($1::text[])
         and not exists (
           select 1 from ritim.blocks block
           where (block.blocker_id = viewer.id and block.blocked_id = peer.id)
              or (block.blocker_id = peer.id and block.blocked_id = viewer.id)
         )
       group by viewer.id, peer.id`,
      [keys],
    )
    for (const row of result.rows) {
      const viewerId = accountByKey.get(row.viewer_key)
      const peerId = accountByKey.get(row.peer_key)
      if (viewerId && peerId) unread.get(viewerId)?.set(peerId, Number(row.unread_count) || 0)
    }
    return unread
  }

  async function markConversationRead(accountId: string, peerAccountId: string) {
    await inTransaction(pool, async (client) => {
      const viewerId = await findUserId(client, accountId)
      const peerId = await findUserId(client, peerAccountId)
      if (!viewerId || !peerId || viewerId === peerId) return
      await client.query(
        `update ritim.conversation_members viewer_member
         set last_read_message_id = (
           select max(message.id)
           from ritim.messages message
           where message.conversation_id = viewer_member.conversation_id
             and message.deleted_at is null
         )
         where viewer_member.user_id = $1
           and exists (
             select 1
             from ritim.conversation_members peer_member
             where peer_member.conversation_id = viewer_member.conversation_id
               and peer_member.user_id = $2
           )`,
        [viewerId, peerId],
      )
    })
  }

  async function loadMessageRequests(accountIds: string[]) {
    const requests = new Map<string, StoredMessageRequest[]>()
    for (const accountId of accountIds) requests.set(accountId, [])
    if (accountIds.length < 2) return requests

    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const keys = [...accountByKey.keys()]
    const result = await pool.query<{
      requester_key: string
      recipient_key: string
      preview: string
      sent_at: Date
    }>(
      `select
         coalesce(encode(requester.legacy_account_id_hash, 'hex'), requester.public_id::text) as requester_key,
         coalesce(encode(recipient.legacy_account_id_hash, 'hex'), recipient.public_id::text) as recipient_key,
         first_message.body as preview,
         first_message.sent_at
       from ritim.message_requests request
       join ritim.users requester on requester.id = request.requester_id
       join ritim.users recipient on recipient.id = request.recipient_id
       join lateral (
         select message.body, message.sent_at
         from ritim.messages message
         where message.conversation_id = request.conversation_id
           and message.deleted_at is null
         order by message.sent_at asc, message.id asc
         limit 1
       ) first_message on true
       where request.status = 'pending'
         and coalesce(encode(requester.legacy_account_id_hash, 'hex'), requester.public_id::text) = any($1::text[])
         and coalesce(encode(recipient.legacy_account_id_hash, 'hex'), recipient.public_id::text) = any($1::text[])
         and not exists (
           select 1 from ritim.blocks block
           where (block.blocker_id = requester.id and block.blocked_id = recipient.id)
              or (block.blocker_id = recipient.id and block.blocked_id = requester.id)
         )
       order by request.created_at asc`,
      [keys],
    )
    for (const row of result.rows) {
      const requesterId = accountByKey.get(row.requester_key)
      const recipientId = accountByKey.get(row.recipient_key)
      if (!requesterId || !recipientId) continue
      requests.get(requesterId)?.push({
        userId: recipientId,
        direction: 'outgoing',
        preview: row.preview,
        sentAt: row.sent_at.getTime(),
      })
      requests.get(recipientId)?.push({
        userId: requesterId,
        direction: 'incoming',
        preview: row.preview,
        sentAt: row.sent_at.getTime(),
      })
    }
    return requests
  }

  async function respondToMessageRequest(
    recipientAccountId: string,
    requesterAccountId: string,
    action: 'accept' | 'reject',
  ) {
    await inTransaction(pool, async (client) => {
      const recipientId = await findUserId(client, recipientAccountId)
      const requesterId = await findUserId(client, requesterAccountId)
      if (!recipientId || !requesterId || recipientId === requesterId) {
        throw new Error('Mesaj isteği kullanıcıları bulunamadı.')
      }
      const updated = await client.query<{ conversation_id: string }>(
        `update ritim.message_requests
         set status = $3, responded_at = now()
         where requester_id = $1
           and recipient_id = $2
           and status = 'pending'
         returning conversation_id`,
        [requesterId, recipientId, action === 'accept' ? 'accepted' : 'rejected'],
      )
      const conversationId = updated.rows[0]?.conversation_id
      if (!conversationId) throw new Error('Bekleyen mesaj isteği bulunamadı.')
      if (action === 'accept') {
        await client.query(
          `update ritim.conversation_members
           set last_read_message_id = (
             select max(message.id)
             from ritim.messages message
             where message.conversation_id = $1
               and message.deleted_at is null
           )
           where conversation_id = $1 and user_id = $2`,
          [conversationId, recipientId],
        )
      } else {
        await client.query(
          `update ritim.messages
           set deleted_at = now()
           where conversation_id = $1 and deleted_at is null`,
          [conversationId],
        )
      }
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
       select request.requester_id as left_id, request.recipient_id as right_id, 'contact'::text as kind
       from ritim.message_requests request
       where request.status = 'accepted'
         and request.requester_id = any($1::bigint[])
         and request.recipient_id = any($1::bigint[])`,
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
    const removedMemberKeys = await inTransaction(pool, async (client) => {
      const ownerId = await findUserId(client, accountId)
      if (!ownerId) throw new Error('Gizlilik ayarı için kullanıcı bulunamadı.')
      await client.query(
        `update ritim.users
         set profile_visibility = $2, listening_visibility = $3
         where id = $1`,
        [ownerId, preferences.profileVisibility, preferences.listeningVisibility],
      )
      if (preferences.listeningVisibility === 'everyone') return []
      const removed = await client.query<{ account_key: string }>(
        `update ritim.room_members member
         set left_at = now()
         from ritim.listening_rooms room, ritim.users listener
         where member.room_id = room.id
           and listener.id = member.user_id
           and room.owner_id = $1
           and room.ended_at is null
           and member.role = 'listener'
           and member.left_at is null
           and (
             $2 = 'hidden'
             or not exists (
               select 1
               from ritim.message_requests request
               where request.status = 'accepted'
                 and (
                   (request.requester_id = $1 and request.recipient_id = member.user_id)
                   or (request.requester_id = member.user_id and request.recipient_id = $1)
                 )
             )
           )
         returning coalesce(
           encode(listener.legacy_account_id_hash, 'hex'),
           listener.public_id::text
         ) as account_key`,
        [ownerId, preferences.listeningVisibility],
      )
      return removed.rows.map((row) => redisKeyFromDatabaseAccountKey(row.account_key))
    })
    await Promise.all(removedMemberKeys.map((memberKey) => (
      redis.del(`ritim:listening:${memberKey}`)
    )))
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
      await client.query(
        `update ritim.room_members member
         set left_at = now()
         from ritim.listening_rooms room
         where member.room_id = room.id
           and room.ended_at is null
           and member.role = 'listener'
           and member.left_at is null
           and (
             (room.owner_id = $1 and member.user_id = $2)
             or (room.owner_id = $2 and member.user_id = $1)
           )`,
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
    const result = await inTransaction(pool, async (client) => {
      const ownerId = await findUserId(client, ownerAccountId)
      if (!ownerId) throw new Error('Oda sahibi bulunamadı.')
      await client.query('select pg_advisory_xact_lock($1)', [ownerId])
      const activeMemberKeys = await client.query<{ account_key: string }>(
        `select coalesce(
           encode(member_user.legacy_account_id_hash, 'hex'),
           member_user.public_id::text
         ) as account_key
         from ritim.room_members member
         join ritim.listening_rooms room on room.id = member.room_id
         join ritim.users member_user on member_user.id = member.user_id
         where room.owner_id = $1
           and room.ended_at is null
           and member.left_at is null`,
        [ownerId],
      )
      const ended = await client.query<{ id: string; public_id: string }>(
        `update ritim.listening_rooms
         set ended_at = now()
         where owner_id = $1 and ended_at is null
         returning id, public_id`,
        [ownerId],
      )
      if (ended.rowCount) {
        await client.query(
          `update ritim.room_members
           set left_at = now()
           where room_id = any($1::bigint[]) and left_at is null`,
          [ended.rows.map((row) => row.id)],
        )
        await client.query(
          'delete from ritim.room_messages where room_id = any($1::bigint[])',
          [ended.rows.map((row) => row.id)],
        )
        return {
          created: false,
          endedRoomPublicIds: ended.rows.map((row) => row.public_id),
          memberRedisKeys: activeMemberKeys.rows.map((row) => (
            redisKeyFromDatabaseAccountKey(row.account_key)
          )),
        }
      }

      await client.query(
        `update ritim.room_members
         set left_at = now()
         where user_id = $1 and left_at is null`,
        [ownerId],
      )
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
      return {
        created: true,
        endedRoomPublicIds: [],
        memberRedisKeys: [hashHex(ownerAccountId)],
      }
    })
    if (result.memberRedisKeys.length) {
      await Promise.all(result.memberRedisKeys.map((memberKey) => (
        redis.del(`ritim:listening:${memberKey}`)
      )))
    }
    if (result.endedRoomPublicIds.length) {
      await Promise.all(result.endedRoomPublicIds.map((roomPublicId) => (
        redis.del(`ritim:room-playback:${roomPublicId}`)
      )))
    }
    return result.created
  }

  async function loadRoomPlaybacks(roomIds: string[]) {
    const publicIds = roomIds.map((roomId) => roomId.replace(/^room-/, ''))
    if (!publicIds.length) return new Map<string, RoomPlayback>()
    const values = await redis.mGet(publicIds.map((publicId) => `ritim:room-playback:${publicId}`))
    const playbacks = new Map<string, RoomPlayback>()
    values.forEach((value, index) => {
      if (!value) return
      try {
        const playback = JSON.parse(value) as RoomPlayback
        if (playback.roomId === `room-${publicIds[index]}` && playback.playbackRevision > 0) {
          playbacks.set(playback.roomId, playback)
        }
      } catch {}
    })
    return playbacks
  }

  async function publishRoomPlayback(ownerAccountId: string, playback: RoomPlayback) {
    const roomPublicId = playback.roomId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(roomPublicId)) throw new Error('Oda oynatma yetkisi bulunamadı.')
    const ownerResult = await pool.query(
      `select 1
       from ritim.listening_rooms room
       join ritim.users owner on owner.id = room.owner_id
       where room.public_id = $1
         and room.ended_at is null
         and coalesce(encode(owner.legacy_account_id_hash, 'hex'), owner.public_id::text) = $2`,
      [roomPublicId, accountKey(ownerAccountId)],
    )
    if (!ownerResult.rowCount) throw new Error('Oda oynatma yetkisi bulunamadı.')

    const result = await redis.eval(
      `local current = redis.call('GET', KEYS[1])
       if current then
         local decoded = cjson.decode(current)
         if tonumber(decoded.playbackRevision or 0) >= tonumber(ARGV[1]) then
           return cjson.encode({ accepted = false, playback = decoded })
         end
       end
       local clock = redis.call('TIME')
       local decoded = cjson.decode(ARGV[2])
       decoded.serverTimeMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
       local encoded = cjson.encode(decoded)
       redis.call('SET', KEYS[1], encoded, 'EX', 21600)
       return cjson.encode({ accepted = true, playback = decoded })`,
      {
        keys: [`ritim:room-playback:${roomPublicId}`],
        arguments: [String(playback.playbackRevision), JSON.stringify(playback)],
      },
    )
    return JSON.parse(String(result)) as { accepted: boolean; playback: RoomPlayback }
  }

  async function isRoomListener(accountId: string, roomPublicId: string) {
    const selectedRoomId = roomPublicId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(selectedRoomId)) return false
    const result = await pool.query(
      `select 1
       from ritim.room_members member
       join ritim.listening_rooms room on room.id = member.room_id
       join ritim.users listener on listener.id = member.user_id
       where room.public_id = $1
         and room.ended_at is null
         and member.left_at is null
         and member.role = 'listener'
         and coalesce(encode(listener.legacy_account_id_hash, 'hex'), listener.public_id::text) = $2`,
      [selectedRoomId, accountKey(accountId)],
    )
    return Boolean(result.rowCount)
  }

  async function isRoomMember(accountId: string, roomPublicId: string) {
    const selectedRoomId = roomPublicId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(selectedRoomId)) return false
    const result = await pool.query(
      `select 1
       from ritim.room_members member
       join ritim.listening_rooms room on room.id = member.room_id
       join ritim.users room_user on room_user.id = member.user_id
       where room.public_id = $1
         and room.ended_at is null
         and member.left_at is null
         and coalesce(encode(room_user.legacy_account_id_hash, 'hex'), room_user.public_id::text) = $2`,
      [selectedRoomId, accountKey(accountId)],
    )
    return Boolean(result.rowCount)
  }

  async function saveRoomMessage(accountId: string, message: StoredRoomMessage) {
    const selectedRoomId = message.roomId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(selectedRoomId) || !UUID_PATTERN.test(message.id)) {
      throw new Error('Oda mesajı geçersiz.')
    }
    return inTransaction(pool, async (client) => {
      const senderId = await findUserId(client, accountId)
      if (!senderId) throw new Error('Oda mesajı kullanıcısı bulunamadı.')
      const room = await client.query<{ id: string }>(
        `select room.id
         from ritim.listening_rooms room
         join ritim.room_members member on member.room_id = room.id
         where room.public_id = $1
           and room.ended_at is null
           and member.user_id = $2
           and member.left_at is null
         for update of room`,
        [selectedRoomId, senderId],
      )
      if (!room.rows[0]) throw new Error('Oda mesajı erişimi reddedildi.')
      const inserted = await client.query(
        `insert into ritim.room_messages (public_id, room_id, sender_id, body, sent_at)
         values ($1, $2, $3, $4, $5)
         on conflict (public_id) do nothing`,
        [message.id, room.rows[0].id, senderId, message.text, new Date(message.sentAt)],
      )
      await client.query(
        `delete from ritim.room_messages
         where room_id = $1
           and id not in (
             select id from ritim.room_messages
             where room_id = $1
             order by sent_at desc, id desc
             limit 50
           )`,
        [room.rows[0].id],
      )
      return { duplicate: !inserted.rowCount }
    })
  }

  async function loadRoomMessages(roomIds: string[], accountIds: string[]): Promise<Map<string, StoredRoomMessage[]>> {
    const publicIds = roomIds.map((roomId) => roomId.replace(/^room-/, '')).filter((id) => UUID_PATTERN.test(id))
    const resultByRoom = new Map<string, StoredRoomMessage[]>(roomIds.map((roomId) => [roomId, []]))
    if (!publicIds.length) return resultByRoom
    const accountByKey = new Map(accountIds.map((accountId) => [accountKey(accountId), accountId]))
    const result = await pool.query<{
      room_public_id: string
      public_id: string
      sender_key: string
      body: string
      sent_at: Date
    }>(
      `select room.public_id as room_public_id,
              message.public_id,
              coalesce(encode(sender.legacy_account_id_hash, 'hex'), sender.public_id::text) as sender_key,
              message.body,
              message.sent_at
       from ritim.room_messages message
       join ritim.listening_rooms room on room.id = message.room_id
       join ritim.users sender on sender.id = message.sender_id
       where room.public_id = any($1::uuid[])
         and room.ended_at is null
       order by message.sent_at asc, message.id asc`,
      [publicIds],
    )
    for (const row of result.rows) {
      const roomId = `room-${row.room_public_id}`
      const selected = resultByRoom.get(roomId)
      if (!selected) continue
      selected.push({
        id: row.public_id,
        roomId,
        senderId: accountByKey.get(row.sender_key) || row.sender_key,
        text: row.body,
        sentAt: row.sent_at.getTime(),
      })
    }
    return resultByRoom
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
      member_keys: string[]
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
         ) as member_initials,
         coalesce(
           array_agg(
             coalesce(
               encode(member_user.legacy_account_id_hash, 'hex'),
               member_user.public_id::text
             )
             order by member.joined_at
           ) filter (where member.left_at is null),
           '{}'
         ) as member_keys
       from ritim.listening_rooms room
       join ritim.users owner on owner.id = room.owner_id
       left join ritim.room_members member on member.room_id = room.id
       left join ritim.users member_user on member_user.id = member.user_id
       where room.ended_at is null
          and (
            coalesce(encode(owner.legacy_account_id_hash, 'hex'), owner.public_id::text)
              in (${placeholders})
            or exists (
              select 1
              from ritim.room_members viewer_member
              join ritim.users viewer on viewer.id = viewer_member.user_id
              where viewer_member.room_id = room.id
                and viewer_member.left_at is null
                and coalesce(encode(viewer.legacy_account_id_hash, 'hex'), viewer.public_id::text)
                  in (${placeholders})
            )
          )
       group by room.id, owner.legacy_account_id_hash, owner.public_id
       order by room.started_at asc`,
      keys,
    )
    return result.rows.flatMap((row) => {
      return [{
        id: `room-${row.public_id}`,
        ownerId: accountByKey.get(row.owner_key) || row.owner_key,
        title: row.title,
        cover: Number(row.cover) || 0,
        memberCount: Number(row.member_count) || 0,
        memberInitials: row.member_initials.slice(0, 4),
        memberIds: row.member_keys.flatMap((memberKey) => {
          const memberId = accountByKey.get(memberKey)
          return memberId ? [memberId] : []
        }),
      }]
    })
  }

  async function loadRoomOwnerKey(roomPublicId: string) {
    const selectedRoomId = roomPublicId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(selectedRoomId)) return undefined
    const result = await pool.query<{ owner_key: string }>(
      `select coalesce(
         encode(owner.legacy_account_id_hash, 'hex'),
         owner.public_id::text
       ) as owner_key
       from ritim.listening_rooms room
       join ritim.users owner on owner.id = room.owner_id
       where room.public_id = $1 and room.ended_at is null`,
      [selectedRoomId],
    )
    return result.rows[0]?.owner_key
  }

  async function toggleRoomMembership(listenerAccountId: string, roomPublicId: string) {
    const selectedRoomId = roomPublicId.replace(/^room-/, '')
    if (!UUID_PATTERN.test(selectedRoomId)) throw new Error('Dinleme odası bulunamadı.')
    const membership = await inTransaction(pool, async (client) => {
      const listenerId = await findUserId(client, listenerAccountId)
      if (!listenerId) throw new Error('Oda katılımcısı bulunamadı.')
      const roomResult = await client.query<{
        id: string
        owner_id: string
        owner_key: string
        listening_visibility: Visibility
      }>(
        `select
           room.id,
           room.owner_id,
           coalesce(
             encode(owner.legacy_account_id_hash, 'hex'),
             owner.public_id::text
           ) as owner_key,
           owner.listening_visibility
         from ritim.listening_rooms room
         join ritim.users owner on owner.id = room.owner_id
         where room.public_id = $1 and room.ended_at is null
         for update of room`,
        [selectedRoomId],
      )
      const room = roomResult.rows[0]
      if (!room) throw new Error('Dinleme odası bulunamadı.')
      if (String(room.owner_id) === String(listenerId)) throw new Error('Oda sahibi odadan ayrılamaz.')
      if (!await usersCanInteract(client, listenerId, room.owner_id)) {
        throw new Error('Dinleme odasına erişim engellendi.')
      }
      const visibility = await client.query<{ listening_visibility: Visibility; is_contact: boolean }>(
        `select $3::text as listening_visibility,
                exists (
                  select 1
                  from ritim.message_requests request
                  where request.status = 'accepted'
                    and (
                      (request.requester_id = $1 and request.recipient_id = $2)
                      or (request.requester_id = $2 and request.recipient_id = $1)
                    )
                ) as is_contact
         from ritim.users
         where id = $2`,
        [listenerId, room.owner_id, room.listening_visibility],
      )
      const targetVisibility = visibility.rows[0]
      if (
        targetVisibility?.listening_visibility === 'hidden'
        || (targetVisibility?.listening_visibility === 'contacts' && !targetVisibility.is_contact)
      ) throw new Error('Dinleme odasına erişim engellendi.')

      const currentMembership = await client.query<{ room_id: string; role: 'owner' | 'listener' }>(
        `select room_id, role
         from ritim.room_members
         where user_id = $1 and left_at is null
         for update`,
        [listenerId],
      )
      if (currentMembership.rows[0]?.role === 'owner') {
        throw new Error('Oda sahibi odadan ayrılamaz.')
      }
      const leaving = String(currentMembership.rows[0]?.room_id || '') === String(room.id)

      await client.query(
        `update ritim.room_members
         set left_at = now()
         where user_id = $1 and role = 'listener' and left_at is null`,
        [listenerId],
      )
      if (leaving) {
        return {
          status: 'left' as const,
          ownerRedisKey: redisKeyFromDatabaseAccountKey(room.owner_key),
        }
      }

      const countResult = await client.query<{ member_count: string }>(
        `select count(*) as member_count
         from ritim.room_members
         where room_id = $1 and left_at is null`,
        [room.id],
      )
      if (Number(countResult.rows[0]?.member_count || 0) >= MAX_ROOM_MEMBERS) {
        throw new Error('Dinleme odası dolu.')
      }
      await client.query(
        `insert into ritim.room_members (room_id, user_id, role)
         values ($1, $2, 'listener')
         on conflict (room_id, user_id) do update set
           role = 'listener',
           joined_at = now(),
           left_at = null`,
        [room.id, listenerId],
      )
      return {
        status: 'joined' as const,
        ownerRedisKey: redisKeyFromDatabaseAccountKey(room.owner_key),
      }
    })

    const listeningKey = `ritim:listening:${hashHex(listenerAccountId)}`
    if (membership.status === 'left') await redis.del(listeningKey)
    else await redis.set(listeningKey, membership.ownerRedisKey, { EX: LISTENING_TTL_SECONDS })
    return membership.status
  }

  async function toggleListening(listenerAccountId: string, targetAccountId: string) {
    const targetId = await pool.query<{ room_public_id: string }>(
      `select room.public_id as room_public_id
       from ritim.listening_rooms room
       join ritim.users owner on owner.id = room.owner_id
       where room.ended_at is null
         and coalesce(encode(owner.legacy_account_id_hash, 'hex'), owner.public_id::text) = $1`,
      [accountKey(targetAccountId)],
    )
    const roomPublicId = targetId.rows[0]?.room_public_id
    if (!roomPublicId) {
      await clearListening(listenerAccountId)
      throw new Error('Dinleme odası bulunamadı.')
    }
    return toggleRoomMembership(listenerAccountId, `room-${roomPublicId}`)
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
    saveMessageReaction,
    loadNotifications,
    markNotificationsRead,
    loadNotificationPreferences,
    updateNotificationPreferences,
    loadModerationState,
    toggleMute,
    saveReport,
    loadReportSummaries,
    loadMessageRequests,
    respondToMessageRequest,
    loadUnreadCounts,
    markConversationRead,
    saveReaction,
    loadReactions,
    loadAccess,
    loadPrivacy,
    updatePrivacy,
    toggleBlock,
    toggleRoom,
    loadRooms,
    loadRoomPlaybacks,
    loadRoomOwnerKey,
    publishRoomPlayback,
    isRoomListener,
    isRoomMember,
    saveRoomMessage,
    loadRoomMessages,
    toggleRoomMembership,
    toggleListening,
    loadListening,
    clearListening,
  }
}
