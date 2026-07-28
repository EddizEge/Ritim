const assert = require('node:assert/strict')
const test = require('node:test')
const { io: createClient } = require('socket.io-client')

const gatewayUrl = process.env.RITIM_SOCIAL_TEST_URL
const phase = process.env.RITIM_SOCIAL_TEST_PHASE || 'seed'
const messageText = 'Alpha2 kalıcı mesaj'
const roomTitle = 'Alpha2 kalıcı oda'
const accountA = process.env.RITIM_SOCIAL_TEST_ACCOUNT_A || 'alpha2-persistence-account-a'
const accountB = process.env.RITIM_SOCIAL_TEST_ACCOUNT_B || 'alpha2-persistence-account-b'
const accessTokenA = process.env.RITIM_SOCIAL_TEST_ACCESS_TOKEN_A
const accessTokenB = process.env.RITIM_SOCIAL_TEST_ACCESS_TOKEN_B

function profile(id, displayName) {
  return {
    id,
    displayName,
    handle: `@${displayName.toLowerCase().replace(/\s/g, '')}`,
    initials: displayName.slice(0, 2),
    avatarTone: 2,
    deviceRole: 'desktop',
  }
}

async function connect(name, accountId, states, accessToken) {
  const client = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    ...(accessToken ? { auth: { accessToken } } : {}),
  })
  client.on('social:state', (state) => states.set(name, state))
  client.connect()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} gateway bağlantı zaman aşımı`)), 5_000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    client.once('connect_error', reject)
  })
  client.emit('social:join', {
    accountId,
    deviceId: `${accountId}-desktop`,
    deviceRole: 'desktop',
    profile: profile(accountId, name),
  })
  return client
}

async function waitForState(states, name, predicate, timeout = 5_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const state = states.get(name)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${name} için kalıcı sosyal durum gelmedi`)
}

test('mesaj ve oda gateway yeniden başladıktan sonra PostgreSQL’den yüklenir', {
  skip: !gatewayUrl,
}, async (context) => {
  const states = new Map()
  const clientA = await connect('Alpha Bir', accountA, states, accessTokenA)
  const clientB = await connect('Alpha İki', accountB, states, accessTokenB)
  context.after(() => {
    clientA.disconnect()
    clientB.disconnect()
  })

  await waitForState(states, 'Alpha Bir', (state) => state.users.length === 1)
  await waitForState(states, 'Alpha İki', (state) => state.users.length === 1)

  if (phase === 'seed') {
    clientA.emit('social:message', { targetUserId: accountB, text: messageText })
    clientB.emit('social:create-room', { title: roomTitle, cover: 4 })
  }

  const persistedState = await waitForState(states, 'Alpha Bir', (state) => (
    state.conversations[accountB]?.some((message) => message.text === messageText)
    && state.rooms.some((room) => room.title === roomTitle)
  ))
  assert.equal(
    persistedState.conversations[accountB].filter((message) => message.text === messageText).length,
    1,
  )
  assert.equal(persistedState.rooms.find((room) => room.title === roomTitle).cover, 4)
  const recipientState = await waitForState(states, 'Alpha İki', (state) => (
    state.unreadCounts[accountA] >= 1
  ))
  assert.equal(recipientState.unreadCounts[accountA] >= 1, true)
})
