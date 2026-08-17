const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createSocialAuthClient } = require('../electron/social-auth-client.cjs')

test('Electron PKCE istemcisi Ritim tokenlarını safeStorage ile şifreler', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-social-auth-client-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))
  const refreshToken = 'ritim_r1_test-refresh-token-that-must-not-be-plaintext'
  let callbackRequest
  let logoutCalled = false
  let revokedDeviceId = ''
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from([...value].reverse().join('')),
    decryptString: (value) => [...value.toString()].reverse().join(''),
  }
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname
    if (pathname === '/auth/config') {
      return Response.json({
        configured: true,
        required: true,
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        scopes: ['openid', 'profile', 'email'],
        googleClientIds: ['desktop-test.apps.googleusercontent.com'],
      })
    }
    if (pathname === '/auth/google/exchange') {
      const body = JSON.parse(init.body)
      assert.equal(body.code, 'google-test-code')
      assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/)
      assert.equal(body.deviceRole, 'desktop')
      return Response.json({
        accessToken: 'signed-access-token',
        expiresIn: 900,
        refreshToken,
        refreshExpiresIn: 86_400,
        user: { id: 'account-id', displayName: 'Ediz Ege Mercan' },
        device: { id: 'device-id', role: 'desktop' },
      })
    }
    if (pathname === '/auth/companion-ticket') {
      assert.equal(init.headers.authorization, 'Bearer signed-access-token')
      return Response.json({ ticket: 'ritim_ct1_ticket', expiresIn: 120 })
    }
    if (pathname === '/auth/account') {
      assert.equal(init.headers.authorization, 'Bearer signed-access-token')
      return Response.json({
        user: { id: 'account-id', displayName: 'Ediz Ege Mercan', handle: '@ediz_test', initials: 'EE' },
        currentDeviceId: 'device-id',
        devices: [
          { id: 'device-id', role: 'desktop', name: 'Ediz PC', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'phone-id', role: 'companion', name: 'Ediz Telefon', createdAt: '2026-01-02T00:00:00.000Z' },
        ],
      })
    }
    if (pathname === '/auth/devices/phone-id') {
      revokedDeviceId = 'phone-id'
      return new Response(null, { status: 204 })
    }
    if (pathname === '/auth/logout') {
      logoutCalled = true
      return new Response(null, { status: 204 })
    }
    throw new Error(`Beklenmeyen test isteği: ${url}`)
  }
  const shell = {
    async openExternal(url) {
      const authorization = new URL(url)
      const callback = new URL(authorization.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', 'google-test-code')
      callback.searchParams.set('state', authorization.searchParams.get('state'))
      callbackRequest = fetch(callback)
    },
  }
  const client = createSocialAuthClient({
    baseUrl: 'https://social.test',
    userDataPath,
    safeStorage,
    shell,
    clientId: 'desktop-test.apps.googleusercontent.com',
    fetchImpl,
  })

  const signedIn = await client.signIn()
  await callbackRequest
  assert.equal(signedIn.authenticated, true)
  assert.equal(await client.accessToken(), 'signed-access-token')
  assert.equal((await client.createCompanionTicket()).expiresIn, 120)
  const account = await client.account()
  assert.equal(account.devices.length, 2)
  const afterRevoke = await client.revokeDevice('phone-id')
  assert.equal(revokedDeviceId, 'phone-id')
  assert.equal(afterRevoke.authenticated, true)
  const encrypted = await fs.readFile(path.join(userDataPath, 'social-session.bin'))
  assert.equal(encrypted.subarray(0, 4).toString(), 'enc:')
  assert.equal(encrypted.includes(Buffer.from(refreshToken)), false)

  const signedOut = await client.signOut()
  assert.equal(signedOut.authenticated, false)
  assert.equal(logoutCalled, true)
})
