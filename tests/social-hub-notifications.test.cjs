const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')

async function startHub(context) {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const states = new Map()
  const clients = []
  context.after(async () => {
    for (const client of clients) client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  async function connect(accountId) {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'], reconnection: false })
    clients.push(client)
    client.on('social:state', (state) => states.set(accountId, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${accountId}-desktop`,
      deviceRole: 'desktop',
      profile: { displayName: accountId, avatarTone: 1 },
    })
    return client
  }

  async function waitFor(accountId, predicate, label = 'beklenen durum') {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const state = states.get(accountId)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${accountId}: ${label} gelmedi`)
  }

  return { connect, waitFor, url }
}

const ask = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve))
const profileReactions = (state) => state.notifications.filter((item) => item.kind === 'profile_reaction')

async function befriend(waitFor, requester, requesterId, recipient, recipientId) {
  assert.equal((await ask(requester, 'social:message', { targetUserId: recipientId, text: 'Merhaba' })).ok, true)
  await waitFor(recipientId, (state) => state.messageRequests.some((request) => request.userId === requesterId))
  recipient.emit('social:request-response', { requesterUserId: requesterId, action: 'accept' })
  await waitFor(recipientId, (state) => state.messageRequests.length === 0)
}

// Each reaction raises the target's counter even when no notification is
// written, so the counter shows the reaction was processed.
async function react(client, waitFor, targetId, reaction) {
  const before = (await waitFor(targetId, () => true)).currentUser.reactionCount
  client.emit('social:reaction', { targetUserId: targetId, reaction })
  return waitFor(targetId, (state) => state.currentUser.reactionCount > before, `${reaction} tepkisi`)
}

test('profil tepkisi hedefe tek okunmamış bildirim olarak düşer ve tekrarında güncellenir', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-hedef')
  const fan = await connect('pt-hayran')
  await waitFor('pt-hedef', (state) => state.users.length === 1)

  const first = profileReactions(await react(fan, waitFor, 'pt-hedef', '🔥'))
  assert.equal(first.length, 1)
  assert.equal(first[0].actorId, 'pt-hayran')
  assert.equal(first[0].body, '🔥')
  assert.equal(first[0].read, false)
  assert.equal('messageId' in first[0], false, 'profil tepkisinde messageId olmamalı')

  await new Promise((resolve) => setTimeout(resolve, 5))
  const merged = profileReactions(await react(fan, waitFor, 'pt-hedef', '♥'))
  assert.equal(merged.length, 1, 'okunmamış tepki varken yenisi eklenmez')
  assert.equal(merged[0].id, first[0].id)
  assert.equal(merged[0].body, '♥')
  assert.ok(merged[0].createdAt > first[0].createdAt, 'zaman yeni tepkiye göre güncellenir')

  target.emit('social:notifications-read')
  await waitFor('pt-hedef', (state) => state.notifications.every((item) => item.read))
  const afterRead = await react(fan, waitFor, 'pt-hedef', '👍')
  const reactions = profileReactions(afterRead)
  assert.equal(reactions.length, 2, 'okunduktan sonraki tepki yeni bildirimdir')
  assert.equal(afterRead.notifications[0].body, '👍')
  assert.equal(afterRead.notifications[0].read, false)

  const fanState = await waitFor('pt-hayran', () => true)
  assert.equal(profileReactions(fanState).length, 0, 'gönderene bildirim düşmez')
})

test('profil tepkisi bildirimi tepki tercihi ve sessize almaya uyar', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-tercih-hedef')
  const fan = await connect('pt-tercih-hayran')
  const friend = await connect('pt-tercih-arkadas')
  await waitFor('pt-tercih-hedef', (state) => state.users.length === 2)

  target.emit('social:notification-preferences', { messagesEnabled: true, reactionsEnabled: false })
  await waitFor('pt-tercih-hedef', (state) => state.notificationPreferences.reactionsEnabled === false)
  assert.equal(profileReactions(await react(fan, waitFor, 'pt-tercih-hedef', '🔥')).length, 0)

  target.emit('social:notification-preferences', { messagesEnabled: false, reactionsEnabled: true })
  await waitFor('pt-tercih-hedef', (state) => state.notificationPreferences.reactionsEnabled === true)
  assert.equal(
    profileReactions(await react(fan, waitFor, 'pt-tercih-hedef', '🔥')).length,
    1,
    'mesaj bildirimi kapalıyken tepki bildirimi yine düşer',
  )

  await befriend(waitFor, friend, 'pt-tercih-arkadas', target, 'pt-tercih-hedef')
  target.emit('social:mute', { targetUserId: 'pt-tercih-arkadas' })
  await waitFor('pt-tercih-hedef', (state) => state.mutedUserIds.includes('pt-tercih-arkadas'))
  const muted = await react(friend, waitFor, 'pt-tercih-hedef', '♥')
  assert.equal(
    profileReactions(muted).filter((item) => item.actorId === 'pt-tercih-arkadas').length,
    0,
    'sessize alınan kişinin tepkisi bildirim üretmez',
  )
})

test('engel ve profil gizliliği reddettiği tepki için bildirim üretmez', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-gizli-hedef')
  const blocked = await connect('pt-gizli-engelli')
  const stranger = await connect('pt-gizli-yabanci')
  const fan = await connect('pt-gizli-hayran')
  await waitFor('pt-gizli-hedef', (state) => state.users.length === 3)

  target.emit('social:block', { targetUserId: 'pt-gizli-engelli' })
  await waitFor('pt-gizli-engelli', (state) => !state.users.some((user) => user.id === 'pt-gizli-hedef'))
  blocked.emit('social:reaction', { targetUserId: 'pt-gizli-hedef', reaction: '🔥' })

  target.emit('social:privacy', { profileVisibility: 'contacts', listeningVisibility: 'everyone' })
  await waitFor('pt-gizli-yabanci', (state) => !state.users.some((user) => user.id === 'pt-gizli-hedef'))
  stranger.emit('social:reaction', { targetUserId: 'pt-gizli-hedef', reaction: '😂' })

  target.emit('social:privacy', { profileVisibility: 'everyone', listeningVisibility: 'everyone' })
  await waitFor('pt-gizli-hayran', (state) => state.users.some((user) => user.id === 'pt-gizli-hedef'))
  const reacted = await react(fan, waitFor, 'pt-gizli-hedef', '♥')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(reacted.currentUser.reactionCount, 1, 'reddedilen tepkiler sayılmaz')
  assert.deepEqual(
    profileReactions(reacted).map((item) => [item.actorId, item.body]),
    [['pt-gizli-hayran', '♥']],
  )
})

test('profil tepkisi gövdesi yarım emoji bırakmadan kısaltılır', async (context) => {
  const { connect, waitFor } = await startHub(context)
  await connect('pt-uzun-hedef')
  const fan = await connect('pt-uzun-hayran')
  await waitFor('pt-uzun-hedef', (state) => state.users.length === 1)

  // Seven ASCII letters and a surrogate pair: the eighth unit is a high surrogate.
  const reacted = await react(fan, waitFor, 'pt-uzun-hedef', 'abcdefg🔥')
  const [notification] = profileReactions(reacted)
  assert.equal(notification.body, 'abcdefg')
  assert.equal(reacted.currentUser.lastReaction, 'abcdefg')
})

test('olay onayları başarıda ok:true, doğrulama ve yetki hatasında social:error koduyla döner', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const owner = await connect('ack-sahip')
  const friend = await connect('ack-arkadas')
  const other = await connect('ack-diger')
  await waitFor('ack-sahip', (state) => state.users.length === 2)
  const ok = { ok: true }
  const fail = (code) => ({ ok: false, code })

  assert.equal((await ask(friend, 'social:message', { targetUserId: 'ack-sahip', text: 'Merhaba' })).ok, true)
  await waitFor('ack-sahip', (state) => state.messageRequests.length === 1)
  assert.deepEqual(
    await ask(owner, 'social:request-response', { requesterUserId: 'ack-arkadas', action: 'maybe' }),
    fail('invalid_request'),
  )
  assert.deepEqual(await ask(owner, 'social:request-response', { requesterUserId: 'ack-arkadas', action: 'accept' }), ok)
  assert.equal((await waitFor('ack-sahip', () => true)).messageRequests.length, 0, 'onay geldiğinde durum güncellenmiş olur')
  assert.deepEqual(
    await ask(owner, 'social:request-response', { requesterUserId: 'ack-arkadas', action: 'accept' }),
    fail('request_not_found'),
  )

  assert.deepEqual(await ask(owner, 'social:read', { targetUserId: 'ack-arkadas' }), ok)
  assert.deepEqual(await ask(owner, 'social:read', { targetUserId: 'ack-sahip' }), fail('invalid_request'))
  assert.deepEqual(await ask(owner, 'social:read', { targetUserId: 'ack-yok' }), fail('user_not_found'))

  const messageId = (await waitFor('ack-sahip', (state) => state.conversations['ack-arkadas']?.length === 1))
    .conversations['ack-arkadas'][0].id
  const reactTo = (client, targetUserId, selectedMessageId, reaction) => (
    ask(client, 'social:message-reaction', { targetUserId, messageId: selectedMessageId, reaction })
  )
  assert.deepEqual(await reactTo(owner, 'ack-arkadas', messageId, '🔥'), ok)
  assert.deepEqual(await reactTo(owner, 'ack-arkadas', messageId, 'x'), fail('invalid_request'))
  assert.deepEqual(await reactTo(owner, 'ack-arkadas', 'yok', '🔥'), fail('reaction_blocked'))
  assert.deepEqual(await reactTo(other, 'ack-sahip', messageId, '🔥'), fail('reaction_blocked'))

  // A callback without a payload arrives as the only argument.
  assert.deepEqual(await new Promise((resolve) => friend.emit('social:notifications-read', resolve)), ok)
  assert.deepEqual(
    await ask(friend, 'social:notification-preferences', { messagesEnabled: true, reactionsEnabled: true }),
    ok,
  )

  assert.deepEqual(await ask(owner, 'social:mute', { targetUserId: 'ack-arkadas' }), ok)
  assert.deepEqual(await ask(owner, 'social:mute', { targetUserId: 'ack-diger' }), fail('conversation_not_found'))
  assert.deepEqual(await ask(owner, 'social:mute', { targetUserId: 'ack-yok' }), fail('user_not_found'))
  assert.deepEqual(await ask(owner, 'social:mute', { targetUserId: 'ack-sahip' }), fail('invalid_request'))

  assert.deepEqual(await ask(owner, 'social:report', { targetUserId: 'ack-diger', reason: 'Spam' }), ok)
  assert.deepEqual(await ask(owner, 'social:report', { targetUserId: 'ack-diger', reason: 'x' }), fail('invalid_request'))
  assert.deepEqual(await ask(owner, 'social:report', { targetUserId: 'ack-yok', reason: 'Spam' }), fail('user_not_found'))

  assert.deepEqual(
    await ask(owner, 'social:privacy', { profileVisibility: 'everyone', listeningVisibility: 'everyone' }),
    ok,
  )
  assert.deepEqual(await ask(owner, 'social:block', { targetUserId: 'ack-diger' }), ok)
  assert.deepEqual(await ask(owner, 'social:block', { targetUserId: 'ack-sahip' }), fail('invalid_request'))
  assert.deepEqual(await ask(owner, 'social:block', { targetUserId: 'ack-yok' }), fail('user_not_found'))

  assert.deepEqual(await ask(friend, 'social:reaction', { targetUserId: 'ack-sahip', reaction: '♥' }), ok)
  assert.deepEqual(await ask(other, 'social:reaction', { targetUserId: 'ack-sahip', reaction: '♥' }), fail('reaction_blocked'))
  assert.deepEqual(await ask(friend, 'social:reaction', { targetUserId: 'ack-arkadas', reaction: '♥' }), fail('invalid_request'))
  assert.deepEqual(await ask(friend, 'social:reaction', { targetUserId: 'ack-yok', reaction: '♥' }), fail('user_not_found'))

  assert.deepEqual(await ask(friend, 'social:listening', { targetUserId: 'ack-sahip' }), fail('room_not_found'))
  assert.deepEqual(await ask(owner, 'social:create-room', { title: 'Onay odası', cover: 2 }), ok)
  assert.equal((await waitFor('ack-sahip', () => true)).rooms[0]?.viewerRole, 'owner')
  const deniedError = new Promise((resolve) => other.once('social:error', resolve))
  assert.deepEqual(await ask(other, 'social:listening', { targetUserId: 'ack-sahip' }), fail('room_access_denied'))
  assert.deepEqual(await deniedError, { code: 'room_access_denied', event: 'listening' }, 'social:error yine yayınlanır')
  assert.deepEqual(await ask(friend, 'social:listening', { targetUserId: 'ack-sahip' }), ok)
  assert.equal((await waitFor('ack-arkadas', () => true)).listeningWithUserId, 'ack-sahip')
  assert.deepEqual(await ask(friend, 'social:listening', { targetUserId: 'ack-sahip' }), ok)
  assert.equal((await waitFor('ack-arkadas', () => true)).listeningWithUserId, undefined)
  assert.deepEqual(await ask(friend, 'social:listening', { targetUserId: 'ack-yok' }), fail('room_owner_offline'))
})

test('oda sahibinin masaüstü çevrimdışıyken oda açma onayı room_owner_offline döner', async (context) => {
  const { url } = await startHub(context)
  const companion = createClient(url, { transports: ['websocket'], reconnection: false })
  context.after(() => companion.disconnect())
  await new Promise((resolve) => companion.once('connect', resolve))
  const joined = new Promise((resolve) => companion.once('social:state', resolve))
  companion.emit('social:join', {
    accountId: 'ack-telefon',
    deviceId: 'ack-telefon-companion',
    deviceRole: 'companion',
    profile: { displayName: 'Telefon' },
  })
  await joined
  const offlineError = new Promise((resolve) => companion.once('social:error', resolve))
  assert.deepEqual(await ask(companion, 'social:create-room', { title: 'Telefondan' }), { ok: false, code: 'room_owner_offline' })
  assert.deepEqual(await offlineError, { code: 'room_owner_offline', event: 'create-room' })
})

test('katılmamış soket her onaylı olayda invalid_request alır; geri çağrısız olay sessiz kalır', async (context) => {
  const { url } = await startHub(context)
  const anonymous = createClient(url, { transports: ['websocket'], reconnection: false })
  context.after(() => anonymous.disconnect())
  await new Promise((resolve) => anonymous.once('connect', resolve))
  const events = [
    'social:request-response', 'social:read', 'social:message-reaction', 'social:notifications-read',
    'social:mute', 'social:block', 'social:report', 'social:privacy', 'social:notification-preferences',
    'social:listening', 'social:create-room', 'social:reaction',
  ]
  for (const event of events) {
    assert.deepEqual(await ask(anonymous, event, {}), { ok: false, code: 'invalid_request' }, event)
    assert.deepEqual(await ask(anonymous, event, null), { ok: false, code: 'invalid_request' }, `${event} null`)
  }
  // Without a callback nothing is answered and the socket stays usable.
  for (const event of events) anonymous.emit(event, null)
  assert.deepEqual(await ask(anonymous, 'social:read', {}), { ok: false, code: 'invalid_request' })
  assert.equal(anonymous.connected, true)
})

test('hız sınırı onaylı olayda rate_limited döner ve social:error yine yayınlanır', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const client = await connect('ack-hizli')
  await waitFor('ack-hizli', () => true)
  const preferences = { profileVisibility: 'everyone', listeningVisibility: 'everyone' }
  for (let index = 0; index < 12; index += 1) {
    assert.deepEqual(await ask(client, 'social:privacy', preferences), { ok: true })
  }
  const limitedError = new Promise((resolve) => client.once('social:error', resolve))
  assert.deepEqual(await ask(client, 'social:privacy', preferences), { ok: false, code: 'rate_limited' })
  const error = await limitedError
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.event, 'privacy')
})

test('kalıcı store kural reddini koda, altyapı hatasını server_error yanıtına çevirir', async (context) => {
  const consoleError = context.mock.method(console, 'error', () => {})
  const empty = async () => new Map()
  const store = {
    upsertProfile: async () => {},
    touchPresence: async () => {},
    removePresence: async () => {},
    clearListening: async () => {},
    loadMessages: async () => [],
    loadRooms: async () => [],
    loadListening: empty,
    loadReactions: empty,
    loadAccess: empty,
    loadPrivacy: async () => ({ profileVisibility: 'everyone', listeningVisibility: 'everyone' }),
    loadUnreadCounts: empty,
    loadMessageRequests: empty,
    loadNotifications: empty,
    loadNotificationPreferences: empty,
    loadModerationState: async () => ({
      muted: new Map(),
      blocked: new Map(),
      mutedUsers: new Map(),
      blockedUsers: new Map(),
    }),
    loadReportSummaries: empty,
    loadRoomPlaybacks: empty,
    loadRoomMessages: empty,
    respondToMessageRequest: async () => { throw new Error('Bekleyen mesaj isteği bulunamadı.') },
    saveMessageReaction: async () => { throw new Error('Tepki verilecek mesaj bulunamadı.') },
    saveReaction: async () => { throw new Error('Tepki gönderimi engellendi.') },
    toggleMute: async () => { throw new Error('Sessize alınacak kabul edilmiş konuşma bulunamadı.') },
    markNotificationsRead: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    },
    markConversationRead: async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    },
  }
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io, { store })
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const clients = []
  context.after(async () => {
    for (const client of clients) client.disconnect()
    hub.close()
    await io.close()
  })
  const join = async (accountId) => {
    const client = createClient(url, { transports: ['websocket'], reconnection: false })
    clients.push(client)
    await new Promise((resolve) => client.once('connect', resolve))
    const joined = new Promise((resolve) => client.once('social:state', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${accountId}-desktop`,
      deviceRole: 'desktop',
      profile: { displayName: accountId },
    })
    await joined
    return client
  }
  const left = await join('store-sol')
  await join('store-sag')
  const fail = (code) => ({ ok: false, code })

  assert.deepEqual(
    await ask(left, 'social:request-response', { requesterUserId: 'store-sag', action: 'accept' }),
    fail('request_not_found'),
  )
  assert.deepEqual(
    await ask(left, 'social:message-reaction', { targetUserId: 'store-sag', messageId: 'm1', reaction: '♥' }),
    fail('reaction_blocked'),
  )
  assert.deepEqual(await ask(left, 'social:reaction', { targetUserId: 'store-sag', reaction: '♥' }), fail('reaction_blocked'))
  assert.deepEqual(await ask(left, 'social:mute', { targetUserId: 'store-sag' }), fail('conversation_not_found'))
  assert.deepEqual(await ask(left, 'social:notifications-read', {}), fail('server_error'))
  assert.deepEqual(await ask(left, 'social:read', { targetUserId: 'store-sag' }), fail('server_error'))
  assert.equal(
    consoleError.mock.calls.filter((call) => /Bildirimler okunamadı|Okundu bilgisi/.test(String(call.arguments[0]))).length,
    2,
    'altyapı hatası eskisi gibi günlüğe yazılır',
  )
})
