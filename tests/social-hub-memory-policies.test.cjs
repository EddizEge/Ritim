const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')

// Memory mode backs development and tests, so it must enforce the same block
// and privacy rules as the PostgreSQL store (usersCanInteract and the room
// membership visibility check).
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

  return { connect, waitFor }
}

const ask = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve))
const message = (client, targetUserId, text) => ask(client, 'social:message', { targetUserId, text })

async function befriend(waitFor, requester, requesterId, recipient, recipientId) {
  assert.equal((await message(requester, recipientId, 'Merhaba')).ok, true)
  await waitFor(recipientId, (state) => state.messageRequests.some((request) => request.userId === requesterId))
  recipient.emit('social:request-response', { requesterUserId: requesterId, action: 'accept' })
  await waitFor(recipientId, (state) => state.messageRequests.length === 0)
}

test('bellek modunda engel ve profil gizliliği mesajı PostgreSQL gibi reddeder', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const owner = await connect('mesaj-sahibi')
  const blocked = await connect('mesaj-engelli')
  const stranger = await connect('mesaj-yabanci')
  const friend = await connect('mesaj-arkadas')
  await waitFor('mesaj-sahibi', (state) => state.users.length === 3)
  await befriend(waitFor, friend, 'mesaj-arkadas', owner, 'mesaj-sahibi')

  owner.emit('social:block', { targetUserId: 'mesaj-engelli' })
  await waitFor('mesaj-engelli', (state) => !state.users.some((user) => user.id === 'mesaj-sahibi'))
  assert.deepEqual(await message(blocked, 'mesaj-sahibi', 'Engelliyim'), { ok: false, code: 'message_blocked' })

  owner.emit('social:privacy', { profileVisibility: 'contacts', listeningVisibility: 'everyone' })
  await waitFor('mesaj-yabanci', (state) => !state.users.some((user) => user.id === 'mesaj-sahibi'))
  assert.deepEqual(await message(stranger, 'mesaj-sahibi', 'Tanışalım'), { ok: false, code: 'message_blocked' })
  assert.deepEqual(await message(friend, 'mesaj-sahibi', 'Kişiyim'), { ok: true, duplicate: false })

  owner.emit('social:privacy', { profileVisibility: 'hidden', listeningVisibility: 'everyone' })
  await waitFor('mesaj-arkadas', (state) => !state.users.some((user) => user.id === 'mesaj-sahibi'))
  assert.deepEqual(await message(friend, 'mesaj-sahibi', 'Gizli'), { ok: false, code: 'message_blocked' })

  const ownerState = await waitFor('mesaj-sahibi', (state) => Boolean(state.conversations))
  assert.equal(ownerState.messageRequests.length, 0, 'reddedilen mesaj istek oluşturmamalı')
  assert.equal(ownerState.notifications.filter((item) => item.actorId !== 'mesaj-arkadas').length, 0)
})

test('bellek modunda engellenen kullanıcının profil tepkisi sayılmaz', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('tepki-hedef')
  const blocked = await connect('tepki-engelli')
  const fan = await connect('tepki-hayran')
  await waitFor('tepki-hedef', (state) => state.users.length === 2)

  target.emit('social:block', { targetUserId: 'tepki-engelli' })
  await waitFor('tepki-engelli', (state) => !state.users.some((user) => user.id === 'tepki-hedef'))
  blocked.emit('social:reaction', { targetUserId: 'tepki-hedef', reaction: '🔥' })
  fan.emit('social:reaction', { targetUserId: 'tepki-hedef', reaction: '♥' })
  const reacted = await waitFor('tepki-hedef', (state) => state.currentUser.reactionCount >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(reacted.currentUser.reactionCount, 1)
  assert.equal(reacted.currentUser.lastReaction, '♥')
})

test('bellek modunda oda katılımı engel ve dinleme gizliliğine uyar', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const owner = await connect('oda-sahibi')
  const blocked = await connect('oda-engelli')
  const stranger = await connect('oda-yabanci')
  const friend = await connect('oda-arkadas')
  await waitFor('oda-sahibi', (state) => state.users.length === 3)
  await befriend(waitFor, friend, 'oda-arkadas', owner, 'oda-sahibi')

  owner.emit('social:create-room', { title: 'Kurallı oda', cover: 1 })
  const roomId = (await waitFor('oda-sahibi', (state) => state.rooms[0]?.viewerRole === 'owner')).rooms[0].id

  owner.emit('social:block', { targetUserId: 'oda-engelli' })
  await waitFor('oda-engelli', (state) => state.rooms.length === 0)
  assert.deepEqual(await ask(blocked, 'social:room-membership', { roomId }), { ok: false, code: 'room_access_denied' })
  const listeningError = new Promise((resolve) => blocked.once('social:error', resolve))
  blocked.emit('social:listening', { targetUserId: 'oda-sahibi' })
  assert.deepEqual(await listeningError, { code: 'room_access_denied', event: 'listening' })

  owner.emit('social:privacy', { profileVisibility: 'everyone', listeningVisibility: 'contacts' })
  await waitFor('oda-yabanci', (state) => state.rooms.length === 0)
  assert.deepEqual(await ask(stranger, 'social:room-membership', { roomId }), { ok: false, code: 'room_access_denied' })
  assert.deepEqual(await ask(friend, 'social:room-membership', { roomId }), { ok: true, status: 'joined' })

  const ownerState = await waitFor('oda-sahibi', (state) => state.rooms[0]?.memberCount === 2)
  assert.equal(ownerState.rooms[0].memberCount, 2, 'yalnız izinli kişi odaya girer')
  assert.deepEqual(await ask(friend, 'social:room-membership', { roomId }), { ok: true, status: 'left' })
})
