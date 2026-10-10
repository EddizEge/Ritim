import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { createSocialInfrastructure, readSocialInfrastructureConfig } from '../server/social-infrastructure'
import { createDurableSocialStore, NOTIFICATION_LIMIT_PER_ACCOUNT } from '../server/social-store'

// Opt-in: runs the durable store against real PostgreSQL + Redis (for example
// the temporary containers of the CI `social-gateway` job). Needs
// RITIM_SOCIAL_STORE_TEST=true and the gateway's RITIM_DB_* / RITIM_REDIS_*
// variables for the `ritim_app` role. Never point it at production.
const enabled = process.env.RITIM_SOCIAL_STORE_TEST === 'true'
const runId = crypto.randomUUID().slice(0, 8)

function legacyAccountKey(accountId: string) {
  return crypto.createHash('sha256').update(accountId).digest('hex')
}

async function withStore(
  context: { after: (callback: () => Promise<void>) => void },
) {
  const infrastructure = createSocialInfrastructure(readSocialInfrastructureConfig())
  await infrastructure.start()
  context.after(() => infrastructure.close())
  assert.ok(infrastructure.pool && infrastructure.redis, 'PostgreSQL ve Redis ayarlanmalı')
  const store = createDurableSocialStore(infrastructure.pool, infrastructure.redis as never)
  const join = async (name: string) => {
    const accountId = `store-${runId}-${name}`
    await store.upsertProfile(accountId, `${accountId}-desktop`, {
      id: accountId,
      displayName: name,
      handle: `@${name}`,
      initials: name.slice(0, 2).toUpperCase(),
      avatarTone: 1,
      deviceRole: 'desktop',
    })
    return accountId
  }
  return { store, join }
}

test('PostgreSQL bildirimleri hesap başına sınırlar; yoğun hesap diğerlerini dışarıda bırakmaz', {
  skip: !enabled,
}, async (context) => {
  const { store, join } = await withStore(context)
  const quiet = await join('quiet')
  const quietSender = await join('quietsender')
  const busy = await join('busy')
  const busySender = await join('busysender')

  const message = (senderId: string, targetId: string, text: string) => store.saveMessage({
    id: crypto.randomUUID(),
    senderId,
    targetId,
    text,
    sentAt: Date.now(),
    reactions: [],
  })
  await message(quietSender, quiet, 'Sessiz hesaba tek istek')
  await message(busySender, busy, 'Yoğun hesaba istek')
  await store.respondToMessageRequest(busy, busySender, 'accept')
  for (let index = 0; index < NOTIFICATION_LIMIT_PER_ACCOUNT + 10; index += 1) {
    await message(busySender, busy, `Yoğun mesaj ${index}`)
  }

  const notifications = await store.loadNotifications([busy, quiet, busySender, quietSender])
  assert.equal(notifications.get(busy)?.length, NOTIFICATION_LIMIT_PER_ACCOUNT)
  assert.equal(notifications.get(busy)?.[0].body, `Yoğun mesaj ${NOTIFICATION_LIMIT_PER_ACCOUNT + 9}`)
  assert.equal(notifications.get(quiet)?.length, 1)
  assert.equal(notifications.get(quiet)?.[0].kind, 'message_request')
  assert.equal(notifications.get(quiet)?.[0].actorId, quietSender)
  assert.equal(notifications.get(busySender)?.length, 0)
})

test('PostgreSQL erişimi çevrimdışı oda sahibi için de hesaplanır; bilinmeyen sahip kural almaz', {
  skip: !enabled,
}, async (context) => {
  const { store, join } = await withStore(context)
  const owner = await join('owner')
  const member = await join('member')
  const blocked = await join('blocked')
  const outsider = await join('outsider')

  assert.equal(await store.toggleRoom(owner, 'Çevrimdışı sahip odası', 2), true)
  const [ownerRoom] = await store.loadRooms([owner])
  assert.equal(await store.toggleRoomMembership(member, ownerRoom.id), 'joined')
  assert.equal(await store.toggleBlock(owner, blocked), true)

  // The owner is offline: only the viewers are connected.
  const viewers = [member, blocked, outsider]
  const rooms = await store.loadRooms(viewers)
  const room = rooms.find((candidate) => candidate.id === ownerRoom.id)
  assert.ok(room, 'üyesi bağlı olan çevrimdışı sahip odası yüklenir')
  const ownerKey = legacyAccountKey(owner)
  assert.equal(room.ownerId, ownerKey)
  assert.deepEqual(room.memberIds, [member])

  const onlineOnly = await store.loadAccess(viewers)
  assert.equal(onlineOnly.get(blocked)?.get(ownerKey), undefined, 'eski çağrı sahibi için kural üretmez')

  const unknownKey = legacyAccountKey(`store-${runId}-missing`)
  const access = await store.loadAccess(viewers, [ownerKey, unknownKey])
  assert.deepEqual(access.get(member)?.get(ownerKey), { profile: true, listening: true })
  assert.deepEqual(access.get(outsider)?.get(ownerKey), { profile: true, listening: true })
  assert.deepEqual(access.get(blocked)?.get(ownerKey), { profile: false, listening: false })
  assert.equal(access.get(member)?.get(unknownKey), undefined, 'bulunmayan sahip gizli sayılır')
  assert.equal(access.has(ownerKey), false, 'çevrimdışı sahip izleyici olarak eklenmez')

  await store.updatePrivacy(owner, { profileVisibility: 'everyone', listeningVisibility: 'contacts' })
  const contactsOnly = await store.loadAccess(viewers, [ownerKey])
  assert.deepEqual(contactsOnly.get(outsider)?.get(ownerKey), { profile: true, listening: false })
})

test('PostgreSQL profil tepkisi bildirimi okunmamışken birleşir, tercih ve sessize almaya uyar', {
  skip: !enabled,
}, async (context) => {
  const { store, join } = await withStore(context)
  const target = await join('ptarget')
  const fan = await join('pfan')
  const friend = await join('pfriend')
  const blocked = await join('pblocked')
  // Actor ids resolve only for accounts in the snapshot, as in the gateway.
  const profileReactions = async () => (await store.loadNotifications([target, fan, friend, blocked])).get(target)!
    .filter((item) => item.kind === 'profile_reaction')

  await store.saveReaction({ actorId: fan, targetId: target, reaction: '🔥' })
  const [first] = await profileReactions()
  assert.equal(first.actorId, fan)
  assert.equal(first.body, '🔥')
  assert.equal(first.messageId, undefined)
  assert.equal(first.read, false)

  await new Promise((resolve) => setTimeout(resolve, 20))
  await store.saveReaction({ actorId: fan, targetId: target, reaction: '♥' })
  const merged = await profileReactions()
  assert.equal(merged.length, 1, 'okunmamış tepki varken yeni satır eklenmez')
  assert.equal(merged[0].id, first.id)
  assert.equal(merged[0].body, '♥')
  assert.ok(merged[0].createdAt > first.createdAt)

  await store.markNotificationsRead(target)
  await store.saveReaction({ actorId: fan, targetId: target, reaction: '👍' })
  const afterRead = await profileReactions()
  assert.deepEqual(afterRead.map((item) => [item.body, item.read]), [['👍', false], ['♥', true]])

  await store.updateNotificationPreferences(target, { messagesEnabled: true, reactionsEnabled: false, deviceEnabled: false })
  await store.markNotificationsRead(target)
  await store.saveReaction({ actorId: fan, targetId: target, reaction: '😂' })
  assert.equal((await profileReactions()).length, 2, 'tepki bildirimi kapalıyken yazılmaz')
  await store.updateNotificationPreferences(target, { messagesEnabled: false, reactionsEnabled: true, deviceEnabled: false })

  await store.saveMessage({
    id: crypto.randomUUID(),
    senderId: friend,
    targetId: target,
    text: 'Merhaba',
    sentAt: Date.now(),
    reactions: [],
  })
  await store.respondToMessageRequest(target, friend, 'accept')
  await store.toggleMute(target, friend)
  await store.saveReaction({ actorId: friend, targetId: target, reaction: '🔥' })
  assert.equal(
    (await profileReactions()).filter((item) => item.actorId === friend).length,
    0,
    'sessize alınan kişinin tepkisi bildirim üretmez',
  )

  assert.equal(await store.toggleBlock(target, blocked), true)
  await assert.rejects(store.saveReaction({ actorId: blocked, targetId: target, reaction: '🔥' }), /engellendi/)
  assert.equal((await profileReactions()).filter((item) => item.actorId === blocked).length, 0)
  const reactionCount = (await store.loadReactions([target])).get(target)?.count
  assert.equal(reactionCount, 5, 'reddedilen tepki sayılmaz; sessize alınan sayılır')

  const burst = await join('pburst')
  await Promise.all(['🔥', '♥', '😂', '👍', '🎵'].map((reaction) => (
    store.saveReaction({ actorId: burst, targetId: target, reaction })
  )))
  const burstNotifications = (await store.loadNotifications([target, burst])).get(target)!
    .filter((item) => item.kind === 'profile_reaction' && item.actorId === burst)
  assert.equal(burstNotifications.length, 1, 'eşzamanlı tepkiler de tek okunmamış satırda birleşir')
})
