const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_SOCIAL_GOOGLE_CLIENT_ID = '881361547543-scabmbi925v6mj97vb4uumbicq5ababt.apps.googleusercontent.com'

function base64url(buffer) {
  return buffer.toString('base64url')
}

function createSocialAuthClient({
  baseUrl,
  userDataPath,
  safeStorage,
  shell,
  clientId = process.env.RITIM_SOCIAL_GOOGLE_CLIENT_ID
    || process.env.RITIM_GOOGLE_CLIENT_ID
    || DEFAULT_SOCIAL_GOOGLE_CLIENT_ID,
  fetchImpl = fetch,
}) {
  const sessionPath = path.join(userDataPath, 'social-session.bin')
  const devicePath = path.join(userDataPath, 'social-device-key')
  let sessionCache
  let deviceKeyCache
  let signInPromise

  async function readSession() {
    if (sessionCache !== undefined) return sessionCache
    try {
      const payload = await fs.readFile(sessionPath)
      if (payload.subarray(0, 4).toString() !== 'enc:') {
        sessionCache = null
        return null
      }
      sessionCache = JSON.parse(safeStorage.decryptString(payload.subarray(4)))
      return sessionCache
    } catch (error) {
      if (error.code === 'ENOENT') {
        sessionCache = null
        return null
      }
      console.warn('[Ritim Social] Güvenli oturum okunamadı; bozuk kayıt temizleniyor:', error?.message || error)
      await fs.rm(sessionPath, { force: true }).catch(() => {})
      sessionCache = null
      return null
    }
  }

  async function writeSession(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows güvenli depolaması hazır değil; Ritim Social tokenı kaydedilmedi.')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(value))
    await fs.mkdir(path.dirname(sessionPath), { recursive: true })
    await fs.writeFile(sessionPath, Buffer.concat([Buffer.from('enc:'), encrypted]), { mode: 0o600 })
    sessionCache = value
  }

  async function clearSession() {
    sessionCache = null
    await fs.rm(sessionPath, { force: true })
  }

  async function deviceKey() {
    if (deviceKeyCache) return deviceKeyCache
    try {
      const saved = (await fs.readFile(devicePath, 'utf8')).trim()
      if (/^[A-Za-z0-9_-]{32,128}$/.test(saved)) {
        deviceKeyCache = saved
        return saved
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    deviceKeyCache = base64url(crypto.randomBytes(32))
    await fs.mkdir(path.dirname(devicePath), { recursive: true })
    await fs.writeFile(devicePath, `${deviceKeyCache}\n`, { encoding: 'utf8', mode: 0o600 })
    return deviceKeyCache
  }

  async function request(resource, options = {}) {
    const { timeoutMs = 15_000, ...fetchOptions } = options
    const response = await fetchImpl(`${baseUrl}${resource}`, {
      ...fetchOptions,
      headers: {
        accept: 'application/json',
        ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}),
        ...fetchOptions.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error(payload?.message || `Ritim Social isteği başarısız (${response.status})`)
      error.code = payload?.error
      error.status = response.status
      throw error
    }
    return payload
  }

  async function storeTokenPair(tokens) {
    const stored = {
      accessToken: tokens.accessToken,
      accessExpiresAt: Date.now() + Number(tokens.expiresIn || 900) * 1000,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: Date.now() + Number(tokens.refreshExpiresIn || 0) * 1000,
      user: tokens.user,
      device: tokens.device,
    }
    await writeSession(stored)
    return stored
  }

  async function refresh() {
    const current = await readSession()
    if (!current?.refreshToken) return null
    try {
      return await storeTokenPair(await request('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      }))
    } catch (error) {
      if (error.status === 401) await clearSession()
      throw error
    }
  }

  async function accessToken({ forceRefresh = false } = {}) {
    const current = await readSession()
    if (!current) return ''
    if (!forceRefresh && current.accessToken && current.accessExpiresAt > Date.now() + 60_000) {
      return current.accessToken
    }
    return (await refresh())?.accessToken || ''
  }

  async function status() {
    let remoteConfig
    try {
      remoteConfig = await request('/auth/config', { timeoutMs: 2_500 })
    } catch {
      remoteConfig = { configured: false, required: false, googleClientIds: [] }
    }
    const current = await readSession()
    return {
      configured: Boolean(
        remoteConfig.configured
        && clientId
        && remoteConfig.googleClientIds?.includes(clientId),
      ),
      required: Boolean(remoteConfig.required),
      authenticated: Boolean(current?.refreshToken),
      user: current?.user,
      device: current?.device,
    }
  }

  async function signIn() {
    if (signInPromise) return signInPromise
    if (!clientId) throw new Error('Ritim Social Google client ID yapılandırılmamış.')
    const remoteConfig = await request('/auth/config')
    if (!remoteConfig.configured || !remoteConfig.googleClientIds?.includes(clientId)) {
      throw new Error('Bu Google client ID Ritim Social sunucusunda izinli değil.')
    }

    signInPromise = new Promise((resolve, reject) => {
      const verifier = base64url(crypto.randomBytes(64))
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
      const expectedState = base64url(crypto.randomBytes(24))
      let settled = false
      let timeout

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callbackServer.close()
        signInPromise = null
        if (error) reject(error)
        else resolve(value)
      }

      const callbackServer = http.createServer(async (incoming, response) => {
        try {
          const incomingUrl = new URL(incoming.url, 'http://127.0.0.1')
          if (incomingUrl.pathname !== '/ritim-social-callback') {
            response.writeHead(404).end()
            return
          }
          if (incomingUrl.searchParams.get('state') !== expectedState) {
            throw new Error('Google giriş güvenlik doğrulaması başarısız.')
          }
          const oauthError = incomingUrl.searchParams.get('error')
          if (oauthError) {
            throw new Error(oauthError === 'access_denied'
              ? 'Google ile giriş iptal edildi.'
              : `Google OAuth hatası: ${oauthError}`)
          }
          const code = incomingUrl.searchParams.get('code')
          if (!code) throw new Error('Google yetkilendirme kodu gelmedi.')
          const redirectUri = `http://127.0.0.1:${callbackServer.address().port}/ritim-social-callback`
          const tokens = await request('/auth/google/exchange', {
            method: 'POST',
            body: JSON.stringify({
              code,
              codeVerifier: verifier,
              clientId,
              redirectUri,
              deviceKey: await deviceKey(),
              deviceName: `Ritim PC • ${os.hostname()}`.slice(0, 80),
              deviceRole: 'desktop',
            }),
          })
          await storeTokenPair(tokens)
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><meta charset="utf-8"><title>Ritim Social</title><style>body{margin:0;display:grid;place-items:center;height:100vh;background:#090909;color:#fff;font:16px system-ui}main{text-align:center}b{color:#ff4d5a;font-size:28px}</style><main><b>Ritim Social bağlandı</b><p>Bu pencereyi kapatıp uygulamaya dönebilirsin.</p></main>')
          finish(null, status())
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end(error.message)
          finish(error)
        }
      })

      callbackServer.on('error', (error) => finish(error))
      callbackServer.listen(0, '127.0.0.1', async () => {
        const redirectUri = `http://127.0.0.1:${callbackServer.address().port}/ritim-social-callback`
        const authUrl = new URL(remoteConfig.authorizationEndpoint)
        authUrl.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: (remoteConfig.scopes || ['openid', 'profile', 'email']).join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: expectedState,
          prompt: 'select_account',
        }).toString()
        try {
          await shell.openExternal(authUrl.toString())
        } catch (error) {
          finish(error)
        }
      })
      timeout = setTimeout(() => finish(new Error('Google ile giriş süresi doldu.')), 180_000)
    })
    return signInPromise
  }

  async function createCompanionTicket() {
    const token = await accessToken()
    if (!token) throw new Error('Telefonu sosyal hesaba eklemek için önce PC’de Google ile giriş yap.')
    return request('/auth/companion-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  async function invalidateAccessToken() {
    const current = await readSession()
    if (!current) return
    await writeSession({ ...current, accessToken: '', accessExpiresAt: 0 })
  }

  async function signOut() {
    const token = await accessToken().catch(() => '')
    if (token) {
      await request('/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    await clearSession()
    return status()
  }

  async function account() {
    const current = await readSession()
    if (!current?.refreshToken) {
      return {
        authenticated: false,
        user: undefined,
        currentDeviceId: '',
        devices: [],
      }
    }
    const token = await accessToken()
    if (!token) throw new Error('Ritim Social oturumu yenilenemedi.')
    try {
      return {
        authenticated: true,
        ...await request('/auth/account', {
          headers: { authorization: `Bearer ${token}` },
        }),
      }
    } catch (error) {
      if (![404, 503].includes(error.status)) throw error
      return {
        authenticated: true,
        user: current.user,
        currentDeviceId: current.device?.id || '',
        devices: current.device?.id ? [{
          id: current.device.id,
          role: current.device.role === 'companion' ? 'companion' : 'desktop',
          name: current.device.role === 'companion' ? 'Ritim Telefon' : `Ritim PC • ${os.hostname()}`,
          createdAt: new Date().toISOString(),
        }] : [],
        limited: true,
        warning: 'Cihaz listesi sunucusu henüz hazır değil; bu cihazdaki güvenli oturum gösteriliyor.',
      }
    }
  }

  async function revokeDevice(targetDeviceId) {
    const token = await accessToken()
    if (!token) throw new Error('Cihazı kaldırmak için Ritim Social oturumu gerekli.')
    await request(`/auth/devices/${encodeURIComponent(targetDeviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    return account()
  }

  return {
    status,
    signIn,
    signOut,
    accessToken,
    invalidateAccessToken,
    createCompanionTicket,
    account,
    revokeDevice,
  }
}

module.exports = { createSocialAuthClient }
