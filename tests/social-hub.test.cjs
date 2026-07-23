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
  const stateAWithB = await waitForState('Ediz PC', (state) => state.users.length === 1)
  const stateBWithA = await waitForState('Deniz PC', (state) => state.users.length === 1)
  assert.equal(stateAWithB.users[0].id, 'account-b')
  assert.equal(stateBWithA.users[0].id, 'account-a')

  desktopA.emit('social:message', { targetUserId: 'account-b', text: 'Selam Deniz' })
  const messagedState = await waitForState('Deniz PC', (state) => state.conversations['account-a']?.length === 1)
  assert.equal(messagedState.conversations['account-a'][0].text, 'Selam Deniz')

  desktopA.emit('social:reaction', { targetUserId: 'account-b', reaction: '🔥' })
  const reactedState = await waitForState('Ediz PC', (state) => state.users[0]?.reactionCount === 1)
  assert.equal(reactedState.users[0].lastReaction, '🔥')

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

  desktopB.disconnect()
  const disconnectedState = await waitForState('Ediz PC', (state) => state.users.length === 0)
  assert.equal(disconnectedState.rooms.length, 0)

  context.after(async () => {
    desktopA.disconnect()
    phoneA.disconnect()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
})
