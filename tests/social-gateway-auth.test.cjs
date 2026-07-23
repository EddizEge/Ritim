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
