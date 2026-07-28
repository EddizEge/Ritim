const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')

function profile(id, displayName, deviceRole) {
  return {
    id,
    displayName,
    handle: `@${displayName.toLowerCase().replace(/\s/g, '')}`,
    initials: displayName.slice(0, 2),
    avatarUrl: `https://example.test/${encodeURIComponent(id)}.png`,
    avatarTone: 0,
    presence: 'online',
    deviceRole,
  }
}

test('PC ve telefon tek hesap, diğer cihazlar ayrı kullanıcı olarak görünür', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const latestStates = new Map()

  const connect = async (name, accountId, deviceRole) => {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'] })
    client.on('social:state', (state) => latestStates.set(name, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${name}-device`,
      deviceRole,
      profile: profile(accountId, name, deviceRole),
    })
    return client
  }

  const waitForState = async (name, predicate, timeout = 2000) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      const state = latestStates.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name} için beklenen sosyal durum gelmedi`)
  }

  const desktopA = await connect('Ediz PC', 'account-a', 'desktop')
  const phoneA = await connect('Ediz Telefon', 'account-a', 'companion')
  const stateA = await waitForState('Ediz PC', (state) => state.currentDeviceCount === 2)
  assert.equal(stateA.users.length, 0)
  assert.equal(stateA.companionConnected, true)
  assert.equal(stateA.currentUser.id, 'account-a')
  assert.equal(stateA.currentUser.displayName, 'Ediz PC')
  assert.equal(stateA.currentUser.avatarUrl, 'https://example.test/account-a.png')

  const desktopB = await connect('Deniz PC', 'account-b', 'desktop')
  const phoneB = await connect('Deniz Telefon', 'account-b', 'companion')
  const stateAWithB = await waitForState('Ediz PC', (state) => state.users.length === 1)
  const stateBWithA = await waitForState('Deniz PC', (state) => state.users.length === 1)
  assert.equal(stateAWithB.users[0].id, 'account-b')
  assert.equal(stateBWithA.users[0].id, 'account-a')

  desktopA.emit('social:message', { targetUserId: 'account-b', text: 'Selam Deniz' })
  const messagedState = await waitForState('Deniz PC', (state) => (
    state.conversations['account-a']?.length === 1 && state.unreadCounts['account-a'] === 1
  ))
  assert.equal(messagedState.conversations['account-a'][0].text, 'Selam Deniz')
  await waitForState('Deniz Telefon', (state) => state.unreadCounts['account-a'] === 1)
  phoneB.emit('social:read', { targetUserId: 'account-a' })
  await waitForState('Deniz PC', (state) => state.unreadCounts['account-a'] === 0)
  await waitForState('Deniz Telefon', (state) => state.unreadCounts['account-a'] === 0)

  desktopA.emit('social:reaction', { targetUserId: 'account-b', reaction: '🔥' })
  const reactedState = await waitForState('Ediz PC', (state) => state.users[0]?.reactionCount === 1)
  assert.equal(reactedState.users[0].lastReaction, '🔥')

  desktopB.emit('social:privacy', {
    profileVisibility: 'hidden',
    listeningVisibility: 'hidden',
  })
  await waitForState('Ediz PC', (state) => state.users.length === 0)
  desktopB.emit('social:privacy', {
    profileVisibility: 'everyone',
    listeningVisibility: 'everyone',
  })
  await waitForState('Ediz PC', (state) => state.users.length === 1)

  desktopB.emit('social:create-room', { title: 'Gece sürüşü', cover: 2 })
  const roomState = await waitForState('Ediz PC', (state) => state.rooms.length === 1)
  assert.equal(roomState.rooms[0].title, 'Gece sürüşü')

  desktopA.emit('social:listening', { targetUserId: 'account-b' })
  const listeningState = await waitForState('Ediz PC', (state) => (
    state.listeningWithUserId === 'account-b' && state.rooms[0]?.memberCount === 2
  ))
  assert.equal(listeningState.rooms[0].memberCount, 2)

  desktopA.emit('social:listening', { targetUserId: 'account-b' })
  const stoppedListeningState = await waitForState('Ediz PC', (state) => (
    !state.listeningWithUserId && state.rooms[0]?.memberCount === 1
  ))
  assert.equal(stoppedListeningState.rooms[0].memberCount, 1)

  desktopB.emit('social:block', { targetUserId: 'account-a' })
  await waitForState('Ediz PC', (state) => state.users.length === 0 && state.rooms.length === 0)
  await waitForState('Deniz PC', (state) => state.users.length === 0)

  desktopB.disconnect()
  const disconnectedState = await waitForState('Ediz PC', (state) => state.users.length === 0)
  assert.equal(disconnectedState.rooms.length, 0)

  context.after(async () => {
    desktopA.disconnect()
    phoneA.disconnect()
    phoneB.disconnect()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
})

test('doğrulanmış socket kimliği istemcinin account ve profil iddiasını ezer', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  const verifiedIdentity = {
    accountId: '10000000-0000-4000-8000-000000000001',
    deviceId: '20000000-0000-4000-8000-000000000001',
    sessionId: '30000000-0000-4000-8000-000000000001',
    deviceRole: 'companion',
    displayName: 'Doğrulanmış Kullanıcı',
    handle: '@verified_user',
    initials: 'DK',
    avatarUrl: 'https://example.test/verified.png',
    avatarTone: 7,
  }
  io.on('connection', (socket) => {
    socket.data.socialIdentity = verifiedIdentity
    hub.attach(socket)
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const client = createClient(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
  })
  context.after(async () => {
    client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  const statePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Doğrulanmış sosyal durum gelmedi')), 2000)
    client.on('social:state', (state) => {
      clearTimeout(timer)
      resolve(state)
    })
  })
  await new Promise((resolve) => client.once('connect', resolve))
  client.emit('social:join', {
    accountId: 'spoofed-account',
    deviceId: 'spoofed-device',
    deviceRole: 'desktop',
    profile: profile('spoofed-account', 'Sahte Kullanıcı', 'desktop'),
  })
  const state = await statePromise

  assert.equal(state.currentUser.id, verifiedIdentity.accountId)
  assert.equal(state.currentUser.displayName, verifiedIdentity.displayName)
  assert.equal(state.currentUser.handle, verifiedIdentity.handle)
  assert.equal(state.currentUser.avatarUrl, verifiedIdentity.avatarUrl)
  assert.equal(state.companionConnected, true)
})

test('socket olay hız sınırı tepki spamini keser ve istemciyi bilgilendirir', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const abuseEvents = []
  const hub = createSocialHub(io, { onAbuse: (event) => abuseEvents.push(event) })
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const sender = createClient(url, { autoConnect: false, transports: ['websocket'] })
  const target = createClient(url, { autoConnect: false, transports: ['websocket'] })
  context.after(async () => {
    sender.disconnect()
    target.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
  const connected = Promise.all([
    new Promise((resolve) => sender.once('connect', resolve)),
    new Promise((resolve) => target.once('connect', resolve)),
  ])
  sender.connect()
  target.connect()
  await connected
  sender.emit('social:join', {
    accountId: 'rate-a',
    deviceId: 'rate-a-device',
    deviceRole: 'desktop',
    profile: profile('rate-a', 'Rate A', 'desktop'),
  })
  target.emit('social:join', {
    accountId: 'rate-b',
    deviceId: 'rate-b-device',
    deviceRole: 'desktop',
    profile: profile('rate-b', 'Rate B', 'desktop'),
  })

  const limited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tepki hız sınırı çalışmadı')), 2_000)
    sender.on('social:error', (error) => {
      if (error.code !== 'rate_limited' || error.event !== 'reaction') return
      clearTimeout(timer)
      resolve(error)
    })
  })
  for (let index = 0; index < 31; index += 1) {
    sender.emit('social:reaction', { targetUserId: 'rate-b', reaction: '♥' })
  }
  const error = await limited
  assert.equal(error.retryAfter > 0, true)
  assert.equal(abuseEvents.some((event) => event.category === 'socket_event:reaction'), true)
})
