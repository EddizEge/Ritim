const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  createPairingRevealStore,
  createPairingSecurity,
  createSafeSettingsData,
  stableSocialAccountId,
} = require('../electron/pairing-security.cjs')

test('eski eşleme anahtarından kurulum kimliğine geçiş sosyal kimliği korur', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-pairing-identity-'))
  const oldToken = 'old_pairing_token_12345678901234567890'
  const newToken = 'new_pairing_token_12345678901234567890'
  await fs.writeFile(path.join(userDataPath, 'pairing-token'), `${oldToken}\n`)
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))

  const security = createPairingSecurity({ userDataPath, generateToken: () => newToken })
  const accountIdBefore = security.socialAccountId()
  assert.equal(accountIdBefore, stableSocialAccountId(oldToken))
  assert.equal((await fs.readFile(path.join(userDataPath, 'installation-id'), 'utf8')).trim(), accountIdBefore)
  assert.notEqual(accountIdBefore, oldToken)

  assert.equal(security.rotatePairingToken(), newToken)
  assert.equal(security.socialAccountId(), accountIdBefore)
  assert.equal((await fs.readFile(path.join(userDataPath, 'pairing-token'), 'utf8')).trim(), newToken)
  assert.equal((await fs.readFile(path.join(userDataPath, 'installation-id'), 'utf8')).trim(), accountIdBefore)
})

test('ortam değişkeniyle yönetilen eşleme anahtarı uygulamadan yenilenemez', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-pairing-managed-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))
  const security = createPairingSecurity({
    userDataPath,
    environmentToken: 'managed_pairing_token_1234567890123456',
  })

  assert.equal(security.isRotationAllowed(), false)
  assert.throws(() => security.rotatePairingToken(), { code: 'PAIRING_TOKEN_MANAGED' })
})

test('kısa veya biçimsiz yönetilen eşleme anahtarı fail-closed reddedilir', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-pairing-invalid-managed-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))

  assert.throws(
    () => createPairingSecurity({ userDataPath, environmentToken: '1234' }),
    { code: 'PAIRING_TOKEN_INVALID' },
  )
})

test('anahtar ve kurulum kimliği mevcut dosyanın üzerine güvenle yazılabilir', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-pairing-atomic-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))
  const generatedTokens = [
    'first_pairing_token_12345678901234567890',
    'second_pairing_token_1234567890123456789',
    'third_pairing_token_12345678901234567890',
  ]
  const security = createPairingSecurity({
    userDataPath,
    generateToken: () => generatedTokens.shift(),
  })

  const originalIdentity = security.socialAccountId()
  assert.equal(security.rotatePairingToken(), 'second_pairing_token_1234567890123456789')
  assert.equal(security.rotatePairingToken(), 'third_pairing_token_12345678901234567890')

  const reopened = createPairingSecurity({ userDataPath })
  assert.equal(reopened.getPairingToken(), 'third_pairing_token_12345678901234567890')
  assert.equal(reopened.socialAccountId(), originalIdentity)
  assert.deepEqual((await fs.readdir(userDataPath)).sort(), ['installation-id', 'pairing-token'])
})

test('ayarlar başlangıç verisi eşleme sırrını, tam URLyi veya QRı serileştirmez', () => {
  const secret = 'secret_pairing_token_1234567890123456'
  const fullUrl = `http://192.168.1.28:8787/?companion=1&room=TEST&token=${secret}`
  const qrDataUrl = 'data:image/png;base64,secret-qr-material'
  const data = createSafeSettingsData({
    appVersion: '0.9.1-beta.1',
    pairingToken: secret,
    phoneUrl: fullUrl,
    qrDataUrl,
    pairing: {
      maskedUrl: 'http://192.168.1.28:8787/…?room=TEST&token=••••••••',
      revealDurationMs: 60_000,
      rotationAllowed: true,
    },
  })
  const serialized = JSON.stringify(data)

  assert.equal('pairingToken' in data, false)
  assert.equal('phoneUrl' in data, false)
  assert.equal('qrDataUrl' in data, false)
  assert.equal('phoneUrl' in data.pairing, false)
  assert.equal('qrDataUrl' in data.pairing, false)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes(fullUrl), false)
  assert.equal(serialized.includes(qrDataUrl), false)
})

test('gerçek settings:get-data handlerı URL veya QR üretmeden güvenli serializer kullanır', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const start = mainSource.indexOf("ipcMain.handle('settings:get-data'")
  const end = mainSource.indexOf("ipcMain.handle('settings:get-social-account'", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const handler = mainSource.slice(start, end)

  assert.match(handler, /return createSafeSettingsData\(/)
  assert.doesNotMatch(handler, /phoneUrl\s*:/)
  assert.doesNotMatch(handler, /qrDataUrl/)
  assert.doesNotMatch(handler, /getPairingToken/)
  assert.doesNotMatch(handler, /QRCode/)
})

test('gösterim kapanınca renderer URLyi maskeler ve QR kaynağını DOMdan siler', async () => {
  const settingsSource = await fs.readFile(path.join(__dirname, '..', 'electron', 'settings.js'), 'utf8')
  const start = settingsSource.indexOf('function maskPairing(')
  const end = settingsSource.indexOf('function showRevealedPairing(', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const maskImplementation = settingsSource.slice(start, end)

  assert.match(maskImplementation, /revealSessionId = ''/)
  assert.match(maskImplementation, /phoneUrl\.value = pairingState\.maskedUrl/)
  assert.match(maskImplementation, /qrCode\.hidden = true/)
  assert.match(maskImplementation, /qrCode\.removeAttribute\('src'\)/)
  assert.match(maskImplementation, /copyButton\.disabled = true/)
})

test('eşleme gösterimi pencereye bağlıdır ve süresi dolunca kopyalanamaz', () => {
  let currentTime = 1_000
  const reveals = createPairingRevealStore({
    ttlMs: 500,
    now: () => currentTime,
    createId: () => 'reveal-session-1',
  })
  const session = reveals.create(41, 'secret-url')

  assert.equal(reveals.resolve(session.sessionId, 41), 'secret-url')
  assert.equal(reveals.resolve(session.sessionId, 42), undefined)
  currentTime = session.expiresAt
  assert.equal(reveals.resolve(session.sessionId, 41), undefined)
})
