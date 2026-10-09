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
