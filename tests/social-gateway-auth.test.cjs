const assert = require('node:assert/strict')
const test = require('node:test')
const { io: createClient } = require('socket.io-client')

const gatewayUrl = process.env.RITIM_SOCIAL_AUTH_TEST_URL
const accessToken = process.env.RITIM_SOCIAL_AUTH_TEST_ACCESS_TOKEN
const expectedAccountId = process.env.RITIM_SOCIAL_AUTH_TEST_ACCOUNT_ID

test('auth-required gateway token olmadan reddeder ve doğrulanmış kimliği kullanır', {
  skip: !gatewayUrl || !accessToken || !expectedAccountId,
}, async (context) => {
  const unauthorized = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
  })
  context.after(() => unauthorized.disconnect())
  const unauthorizedError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Yetkisiz socket reddedilmedi')), 5_000)
    unauthorized.once('connect_error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  unauthorized.connect()
  const rejected = await unauthorizedError
  assert.match(rejected.message, /oturumu gerekli/)

  const authorized = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { accessToken },
  })
  context.after(() => authorized.disconnect())
  const statePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Yetkili sosyal durum gelmedi')), 5_000)
    authorized.on('social:state', (state) => {
      clearTimeout(timer)
      resolve(state)
    })
  })
  authorized.connect()
  await new Promise((resolve, reject) => {
    authorized.once('connect', resolve)
    authorized.once('connect_error', reject)
  })
  authorized.emit('social:join', {
    accountId: 'spoofed-account',
    deviceId: 'spoofed-device',
    deviceRole: 'companion',
    profile: {
      id: 'spoofed-account',
      displayName: 'Sahte Kullanıcı',
      handle: '@spoofed',
      initials: 'SK',
      avatarTone: 11,
    },
  })
  const state = await statePromise

  assert.equal(state.currentUser.id, expectedAccountId)
  assert.notEqual(state.currentUser.displayName, 'Sahte Kullanıcı')

  const ticketResponse = await fetch(`${gatewayUrl}/auth/companion-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  assert.equal(ticketResponse.status, 200)
  const ticket = await ticketResponse.json()
  const companionResponse = await fetch(`${gatewayUrl}/auth/companion/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket: ticket.ticket,
      deviceKey: 'gateway-companion-device-key-123456',
      deviceName: 'Gateway Test Telefon',
    }),
  })
  assert.equal(companionResponse.status, 200)
  const companionTokens = await companionResponse.json()
  assert.equal(companionTokens.user.id, expectedAccountId)
  assert.equal(companionTokens.device.role, 'companion')
  const reusedTicket = await fetch(`${gatewayUrl}/auth/companion/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket: ticket.ticket,
      deviceKey: 'gateway-second-phone-key-12345678',
      deviceName: 'İkinci Test Telefon',
    }),
  })
  assert.equal(reusedTicket.status, 401)

  const companion = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { accessToken: companionTokens.accessToken },
  })
  context.after(() => companion.disconnect())
  const companionState = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Telefon sosyal durumu gelmedi')), 5_000)
    companion.on('social:state', (next) => {
      if (next.currentDeviceCount < 2) return
      clearTimeout(timer)
      resolve(next)
    })
  })
  companion.connect()
  await new Promise((resolve, reject) => {
    companion.once('connect', resolve)
    companion.once('connect_error', reject)
  })
  companion.emit('social:join', {
    accountId: 'spoofed-phone-account',
    deviceId: 'spoofed-phone-device',
    deviceRole: 'desktop',
    profile: {
      id: 'spoofed-phone-account',
      displayName: 'Sahte Telefon',
      handle: '@spoofed_phone',
      initials: 'ST',
      avatarTone: 9,
    },
  })
  const linkedPhone = await companionState
  assert.equal(linkedPhone.currentUser.id, expectedAccountId)
  assert.equal(linkedPhone.companionConnected, true)

  const revokeResponse = await fetch(`${gatewayUrl}/auth/device/current`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  assert.equal(revokeResponse.status, 204)
  authorized.disconnect()

  const revoked = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { accessToken },
  })
  context.after(() => revoked.disconnect())
  const revokedError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('İptal edilen cihaz yeniden bağlandı')), 5_000)
    revoked.once('connect_error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  revoked.connect()
  const revokedConnection = await revokedError
  assert.match(revokedConnection.message, /oturumu geçersiz/)
})
