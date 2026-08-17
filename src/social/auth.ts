import { Capacitor, registerPlugin } from '@capacitor/core'

type SecureStoragePlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

type SocialTokenPair = {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  user: { id: string; displayName: string }
  device: { id: string; role: 'desktop' | 'companion' }
}

type StoredSocialSession = SocialTokenPair & {
  server: string
  accessExpiresAt: number
  refreshExpiresAt: number
}

export type SocialAuthOptions = {
  socialUrl: string
  syncUrl: string
  pairingToken: string
  isCompanion: boolean
}

const secureStorageGlobal = globalThis as typeof globalThis & { __ritimSecureStorage?: SecureStoragePlugin }
const secureStorage = secureStorageGlobal.__ritimSecureStorage
  || registerPlugin<SecureStoragePlugin>('RitimSecureStorage')
secureStorageGlobal.__ritimSecureStorage = secureStorage
const SESSION_KEY = 'social.session.v1'
const DEVICE_KEY = 'social.device.v1'
const SIGNED_OUT_KEY = 'social.signed-out.v1'
const WEB_DEVICE_KEY = 'ritim-social-device:v1'
let memorySession: StoredSocialSession | null = null
let loadedSession: Promise<StoredSocialSession | null> | undefined
let ensurePromise: Promise<string> | undefined

function notifySessionChanged() {
  window.dispatchEvent(new CustomEvent('ritim:social-session-changed'))
}

function isNativeStorage() {
  return Capacitor.isNativePlatform()
}

async function loadSession() {
  if (!loadedSession) {
    loadedSession = (async () => {
      if (!isNativeStorage()) return memorySession
      try {
        const { value } = await secureStorage.get({ key: SESSION_KEY })
        if (!value) return null
        const parsed = JSON.parse(value) as StoredSocialSession
        if (!parsed.refreshToken || !parsed.server) return null
        return parsed
      } catch {
        return null
      }
    })()
  }
  return loadedSession
}

async function readSignedOut() {
  if (isNativeStorage()) {
    const { value } = await secureStorage.get({ key: SIGNED_OUT_KEY }).catch(() => ({ value: null }))
    return value === '1'
  }
  try { return localStorage.getItem(SIGNED_OUT_KEY) === '1' } catch { return false }
}

async function setSignedOut(value: boolean) {
  if (isNativeStorage()) {
    if (value) await secureStorage.set({ key: SIGNED_OUT_KEY, value: '1' })
    else await secureStorage.remove({ key: SIGNED_OUT_KEY }).catch(() => {})
    return
  }
  try {
    if (value) localStorage.setItem(SIGNED_OUT_KEY, '1')
    else localStorage.removeItem(SIGNED_OUT_KEY)
  } catch {}
}

async function saveSession(server: string, tokens: SocialTokenPair) {
  const session: StoredSocialSession = {
    ...tokens,
    server,
    accessExpiresAt: Date.now() + Math.max(0, Number(tokens.expiresIn) || 0) * 1000,
    refreshExpiresAt: Date.now() + Math.max(0, Number(tokens.refreshExpiresIn) || 0) * 1000,
  }
  memorySession = session
  loadedSession = Promise.resolve(session)
  if (isNativeStorage()) {
    await secureStorage.set({ key: SESSION_KEY, value: JSON.stringify(session) })
  }
  return session
}

export async function clearSocialSession() {
  memorySession = null
  loadedSession = Promise.resolve(null)
  if (isNativeStorage()) {
    await secureStorage.remove({ key: SESSION_KEY }).catch(() => {})
  }
}

async function socialDeviceKey() {
  if (isNativeStorage()) {
    const stored = await secureStorage.get({ key: DEVICE_KEY }).catch(() => ({ value: null }))
    if (stored.value) return stored.value
    const value = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
    await secureStorage.set({ key: DEVICE_KEY, value })
    return value
  }
  try {
    const stored = localStorage.getItem(WEB_DEVICE_KEY)
    if (stored) return stored
    const value = `web-${crypto.randomUUID()}`
    localStorage.setItem(WEB_DEVICE_KEY, value)
    return value
  } catch {
    return `web-${crypto.randomUUID()}`
  }
}

async function jsonRequest<T>(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(12_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(payload?.message || `Ritim Social isteği başarısız (${response.status})`)
    Object.assign(error, { status: response.status, code: payload?.error })
    throw error
  }
  return payload as T
}

async function refreshSession(socialUrl: string, session: StoredSocialSession) {
  const tokens = await jsonRequest<SocialTokenPair>(`${socialUrl}/auth/refresh`, {
    method: 'POST',
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  return saveSession(socialUrl, tokens)
}

async function enrollCompanion(options: SocialAuthOptions) {
  const ticket = await jsonRequest<{ ticket: string }>(
    `${options.syncUrl}/social/session-ticket`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${options.pairingToken}` },
    },
  )
  const tokens = await jsonRequest<SocialTokenPair>(
    `${options.socialUrl}/auth/companion/exchange`,
    {
      method: 'POST',
      body: JSON.stringify({
        ticket: ticket.ticket,
        deviceKey: await socialDeviceKey(),
        deviceName: 'Ritim Telefon',
      }),
    },
  )
  return saveSession(options.socialUrl, tokens)
}

async function ensure(options: SocialAuthOptions) {
  if (await readSignedOut()) return ''
  let session = await loadSession()
  if (session?.server !== options.socialUrl) {
    await clearSocialSession()
    session = null
  }
  if (session?.accessToken && session.accessExpiresAt > Date.now() + 60_000) {
    return session.accessToken
  }
  if (session?.refreshToken && session.refreshExpiresAt > Date.now()) {
    try {
      return (await refreshSession(options.socialUrl, session)).accessToken
    } catch (error) {
      if ((error as { status?: number }).status === 401) await clearSocialSession()
      else throw error
    }
  }
  if (!options.isCompanion || !options.pairingToken) return ''
  return (await enrollCompanion(options)).accessToken
}

export function ensureSocialAccessToken(options: SocialAuthOptions) {
  if (!ensurePromise) {
    ensurePromise = ensure(options).finally(() => {
      ensurePromise = undefined
    })
  }
  return ensurePromise
}

export async function invalidateSocialAccessToken() {
  const session = await loadSession()
  if (!session) return
  const invalidated = { ...session, accessToken: '', accessExpiresAt: 0 }
  memorySession = invalidated
  loadedSession = Promise.resolve(invalidated)
  if (isNativeStorage()) {
    await secureStorage.set({ key: SESSION_KEY, value: JSON.stringify(invalidated) })
  }
}

export async function getSocialAccount(options: SocialAuthOptions) {
  const accessToken = await ensureSocialAccessToken(options)
  if (!accessToken) {
    return { authenticated: false, currentDeviceId: '', devices: [] }
  }
  return {
    authenticated: true,
    ...await jsonRequest<{
      user: { id: string; displayName: string; handle: string; initials: string; avatarUrl?: string; avatarTone: number }
      currentDeviceId: string
      devices: Array<{ id: string; role: 'desktop' | 'companion'; name: string; lastSeenAt?: string; createdAt: string }>
    }>(`${options.socialUrl}/auth/account`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  }
}

export async function revokeSocialDevice(options: SocialAuthOptions, deviceId: string) {
  const accessToken = await ensureSocialAccessToken(options)
  if (!accessToken) throw new Error('Cihazı kaldırmak için Ritim Sosyal oturumu gerekli.')
  await jsonRequest<never>(`${options.socialUrl}/auth/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
}

export async function signOutSocialAccount(options: SocialAuthOptions) {
  const accessToken = await ensureSocialAccessToken(options).catch(() => '')
  if (accessToken) {
    await fetch(`${options.socialUrl}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12_000),
    }).catch(() => {})
  }
  await clearSocialSession()
  await setSignedOut(true)
  notifySessionChanged()
}

export async function resumeSocialAccount(options: SocialAuthOptions) {
  await setSignedOut(false)
  await clearSocialSession()
  const token = await ensureSocialAccessToken(options)
  notifySessionChanged()
  return token
}
