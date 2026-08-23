const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const INSTALLATION_ID_PATTERN = /^ritim-[a-z0-9]{1,16}$/

function stableSocialAccountId(seed) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ritim-${(hash >>> 0).toString(36)}`
}

function writePrivateValue(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${value}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    try {
      fs.chmodSync(temporaryPath, 0o600)
    } catch {
      // Windows does not implement Unix file modes. The app-owned userData
      // folder remains the security boundary there.
    }
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

function readPrivateValue(filePath, pattern) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim()
    return pattern.test(value) ? value : ''
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[Ritim] ${path.basename(filePath)} okunamadi:`, error)
    return ''
  }
}

function createPairingSecurity({
  userDataPath,
  environmentToken = '',
  generateToken = () => crypto.randomBytes(24).toString('base64url'),
} = {}) {
  if (!userDataPath) throw new Error('Ritim userData yolu gerekli.')

  const tokenPath = path.join(userDataPath, 'pairing-token')
  const installationIdPath = path.join(userDataPath, 'installation-id')
  const managedToken = String(environmentToken || '').trim()
  if (managedToken && !PAIRING_TOKEN_PATTERN.test(managedToken)) {
    const error = new Error('RITIM_PAIRING_TOKEN 32-128 karakterlik güvenli bir anahtar olmalıdır.')
    error.code = 'PAIRING_TOKEN_INVALID'
    throw error
  }
  let pairingToken = managedToken
  let installationId = ''

  function getPairingToken() {
    if (pairingToken) return pairingToken
    const savedToken = readPrivateValue(tokenPath, PAIRING_TOKEN_PATTERN)
    if (savedToken) {
      pairingToken = savedToken
      return pairingToken
    }
    const generatedToken = String(generateToken() || '').trim()
    if (!PAIRING_TOKEN_PATTERN.test(generatedToken)) {
        throw new Error('Güvenli telefon eşleme anahtarı üretilemedi.')
    }
    writePrivateValue(tokenPath, generatedToken)
    pairingToken = generatedToken
    return pairingToken
  }

  function getInstallationId() {
    if (installationId) return installationId
    installationId = readPrivateValue(installationIdPath, INSTALLATION_ID_PATTERN)
    if (!installationId) {
      // Migration: persist the previous derived account id, not the secret
      // itself. This preserves the fallback identity while future token
      // rotations remain completely independent from it.
      const migratedInstallationId = stableSocialAccountId(getPairingToken())
      writePrivateValue(installationIdPath, migratedInstallationId)
      installationId = migratedInstallationId
    }
    return installationId
  }

  function rotatePairingToken() {
    if (managedToken) {
      const error = new Error('Eşleme anahtarı ortam değişkeniyle yönetiliyor; uygulama içinden yenilenemez.')
      error.code = 'PAIRING_TOKEN_MANAGED'
      throw error
    }
    getInstallationId()
    const previousToken = getPairingToken()
    let nextToken = ''
    for (let attempt = 0; attempt < 4 && (!nextToken || nextToken === previousToken); attempt += 1) {
      nextToken = String(generateToken() || '').trim()
    }
    if (!PAIRING_TOKEN_PATTERN.test(nextToken) || nextToken === previousToken) {
      throw new Error('Yeni güvenli eşleme anahtarı üretilemedi.')
    }
    writePrivateValue(tokenPath, nextToken)
    pairingToken = nextToken
    return nextToken
  }

  return {
    getPairingToken,
    getInstallationId,
    rotatePairingToken,
    isRotationAllowed: () => !managedToken,
    socialAccountId: () => getInstallationId(),
  }
}

function createPairingRevealStore({
  ttlMs = 60_000,
  now = () => Date.now(),
  createId = () => crypto.randomBytes(24).toString('base64url'),
} = {}) {
  const sessions = new Map()

  function prune() {
    const currentTime = now()
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(sessionId)
    }
  }

  function create(ownerId, value) {
    prune()
    invalidateOwner(ownerId)
    const sessionId = createId()
    const session = { ownerId, value, expiresAt: now() + ttlMs }
    sessions.set(sessionId, session)
    return { sessionId, expiresAt: session.expiresAt }
  }

  function resolve(sessionId, ownerId) {
    prune()
    const session = sessions.get(String(sessionId || ''))
    if (!session || session.ownerId !== ownerId) return undefined
    return session.value
  }

  function invalidateOwner(ownerId) {
    for (const [sessionId, session] of sessions) {
      if (session.ownerId === ownerId) sessions.delete(sessionId)
    }
  }

  function invalidateAll() {
    sessions.clear()
  }

  return { create, resolve, invalidateOwner, invalidateAll, ttlMs }
}

function createSafeSettingsData(data = {}) {
  return {
    appVersion: data.appVersion,
    computerName: data.computerName,
    electronVersion: data.electronVersion,
    room: data.room,
    serverReady: data.serverReady === true,
    updateStatus: data.updateStatus,
    socialAuth: data.socialAuth,
    socialAccount: data.socialAccount,
    socialState: data.socialState,
    devicePreferences: data.devicePreferences,
    productInfo: data.productInfo,
    pairing: {
      maskedUrl: data.pairing?.maskedUrl || 'Eşleme bağlantısı gizli',
      revealDurationMs: Number(data.pairing?.revealDurationMs) || 60_000,
      rotationAllowed: data.pairing?.rotationAllowed === true,
    },
  }
}

module.exports = {
  createPairingRevealStore,
  createPairingSecurity,
  createSafeSettingsData,
  stableSocialAccountId,
}
