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

  async function connect(name, accountId, deviceRole = 'desktop') {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'], reconnection: false })
    clients.push(client)
    client.on('social:state', (state) => states.set(name, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${name}-device`,
      deviceRole,
      profile: { displayName: name, initials: name.slice(0, 2), avatarTone: 1 },
    })
    return client
  }

  async function waitFor(name, predicate, label = 'beklenen durum') {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const state = states.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name}: ${label} gelmedi`)
  }

  // Lets any broadcast already queued settle before asserting an absence.
  async function settle(name) {
    const before = states.get(name)
    await new Promise((resolve) => setTimeout(resolve, 80))
    return states.get(name) || before
  }

  return { connect, waitFor, settle }
}

const ask = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve))

test('sahibi çevrimdışı oda engellenen kullanıcıya görünmez; üye görmeye devam eder', async (context) => {
  const { connect, waitFor, settle } = await startHub(context)
  const owner = await connect('Oda Sahibi', 'privacy-owner')
  const member = await connect('Üye Dinleyici', 'privacy-member')
  const blocked = await connect('Engelli Kişi', 'privacy-blocked')
  await waitFor('Engelli Kişi', (state) => state.users.length === 2)

  owner.emit('social:create-room', { title: 'Gizli kalmalı', cover: 2 })
  const roomId = (await waitFor('Üye Dinleyici', (state) => state.rooms[0]?.title === 'Gizli kalmalı')).rooms[0].id
  assert.deepEqual(await ask(member, 'social:room-membership', { roomId }), { ok: true, status: 'joined' })
  await ask(owner, 'social:room-playback:update', {
    roomId,
    videoId: 'privacy-video',
    playbackPositionMs: 5_000,
    playbackState: 'playing',
    playbackRevision: 1,
  })

  owner.emit('social:block', { targetUserId: 'privacy-blocked' })
  await waitFor('Engelli Kişi', (state) => state.rooms.length === 0, 'engel sonrası gizli oda')

  owner.disconnect()
  const memberState = await waitFor('Üye Dinleyici', (state) => (
    state.rooms[0]?.id === roomId && state.rooms[0]?.lifecycle === 'owner_offline'
  ), 'üyenin çevrimdışı oda görünümü')
  assert.equal(memberState.rooms[0].viewerRole, 'listener')
  assert.equal(memberState.activeRoomId, roomId)

  const blockedState = await settle('Engelli Kişi')
  assert.equal(blockedState.users.some((user) => user.id === 'privacy-owner'), false)
  assert.deepEqual(blockedState.rooms, [], 'engellenen kişi başlığı, baş harfleri ve oynatmayı görmemeli')
  const blockedJoin = await ask(blocked, 'social:room-membership', { roomId })
  assert.equal(blockedJoin.ok, false)
})

test('sahibi çevrimdışı "yalnız kişiler" odası kişisi olmayana görünmez, kişiye görünür', async (context) => {
  const { connect, waitFor, settle } = await startHub(context)
  const owner = await connect('Kişi Sahibi', 'contacts-owner')
  const friend = await connect('Arkadaş', 'contacts-friend')
  await connect('Yabancı', 'contacts-stranger')
  await waitFor('Yabancı', (state) => state.users.length === 2)

  friend.emit('social:message', { targetUserId: 'contacts-owner', text: 'Merhaba' })
  await waitFor('Kişi Sahibi', (state) => state.messageRequests[0]?.direction === 'incoming')
  owner.emit('social:request-response', { requesterUserId: 'contacts-friend', action: 'accept' })
  await waitFor('Kişi Sahibi', (state) => state.messageRequests.length === 0)

  owner.emit('social:privacy', { profileVisibility: 'everyone', listeningVisibility: 'contacts' })
  owner.emit('social:create-room', { title: 'Kişilere açık', cover: 1 })
  const roomId = (await waitFor('Arkadaş', (state) => state.rooms[0]?.title === 'Kişilere açık')).rooms[0].id
  assert.deepEqual((await settle('Yabancı')).rooms, [])

  owner.disconnect()
  await waitFor('Arkadaş', (state) => (
    state.rooms[0]?.id === roomId
    && state.rooms[0]?.lifecycle === 'owner_offline'
    && state.rooms[0]?.viewerRole === undefined
  ), 'kişinin çevrimdışı oda görünümü')
  await waitFor('Yabancı', (state) => !state.users.some((user) => user.id === 'contacts-owner'))
  assert.deepEqual((await settle('Yabancı')).rooms, [], 'kişisi olmayan çevrimdışı odayı görmemeli')
})
