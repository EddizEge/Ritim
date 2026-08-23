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
  user: { id: string; displayName: string; handle?: string; initials?: string; avatarUrl?: string; avatarTone?: number }
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
let ensurePromiseKey = ''
let sessionGeneration = 0
let secureStorageTail: Promise<void> = Promise.resolve()

function staleSessionOperationError() {
  return new DOMException('Sosyal oturum işlemi iptal edildi.', 'AbortError')
}

function invalidatePendingSessionOperations() {
  sessionGeneration += 1
  ensurePromise = undefined
  ensurePromiseKey = ''
  return sessionGeneration
}

function socialAuthContextKey(options: SocialAuthOptions) {
  return [options.socialUrl, options.syncUrl, options.pairingToken, options.isCompanion ? 'companion' : 'desktop'].join('|')
}

function assertSessionGeneration(generation: number) {
  if (generation !== sessionGeneration) throw staleSessionOperationError()
}

function runSecureStorageOperation<T>(operation: () => Promise<T>) {
  const result = secureStorageTail.then(operation, operation)
  secureStorageTail = result.then(() => undefined, () => undefined)
  return result
}

function notifySessionChanged() {
  window.dispatchEvent(new CustomEvent('ritim:social-session-changed'))
}

function isNativeStorage() {
  return Capacitor.isNativePlatform()
}

function sessionInitials(displayName: string) {
  return displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('tr') || 'R'
}

async function loadSession() {
  if (!loadedSession) {
    loadedSession = (async () => {
      if (!isNativeStorage()) return memorySession
      try {
        const { value } = await runSecureStorageOperation(() => secureStorage.get({ key: SESSION_KEY }))
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
    const { value } = await runSecureStorageOperation(() => secureStorage.get({ key: SIGNED_OUT_KEY }))
      .catch(() => ({ value: null }))
    return value === '1'
  }
  try { return localStorage.getItem(SIGNED_OUT_KEY) === '1' } catch { return false }
}

async function setSignedOut(value: boolean, generation: number) {
  assertSessionGeneration(generation)
  if (isNativeStorage()) {
    await runSecureStorageOperation(async () => {
      assertSessionGeneration(generation)
      if (value) await secureStorage.set({ key: SIGNED_OUT_KEY, value: '1' })
      else await secureStorage.remove({ key: SIGNED_OUT_KEY }).catch(() => {})
      assertSessionGeneration(generation)
    })
    return
  }
  assertSessionGeneration(generation)
  try {
    if (value) localStorage.setItem(SIGNED_OUT_KEY, '1')
    else localStorage.removeItem(SIGNED_OUT_KEY)
  } catch {}
}

async function persistStoredSession(session: StoredSocialSession, generation: number) {
  assertSessionGeneration(generation)
  if (isNativeStorage()) {
    await runSecureStorageOperation(async () => {
      assertSessionGeneration(generation)
      await secureStorage.set({ key: SESSION_KEY, value: JSON.stringify(session) })
      if (generation !== sessionGeneration) {
        await secureStorage.remove({ key: SESSION_KEY }).catch(() => {})
        throw staleSessionOperationError()
      }
    })
  }
  assertSessionGeneration(generation)
  memorySession = session
  loadedSession = Promise.resolve(session)
  return session
}

async function saveSession(server: string, tokens: SocialTokenPair, generation: number) {
  const session: StoredSocialSession = {
    ...tokens,
    server,
    accessExpiresAt: Date.now() + Math.max(0, Number(tokens.expiresIn) || 0) * 1000,
    refreshExpiresAt: Date.now() + Math.max(0, Number(tokens.refreshExpiresIn) || 0) * 1000,
  }
  return persistStoredSession(session, generation)
}

async function clearStoredSocialSession(generation: number) {
  if (generation !== sessionGeneration) return false
  memorySession = null
  loadedSession = Promise.resolve(null)
  if (isNativeStorage()) {
    await runSecureStorageOperation(async () => {
      if (generation !== sessionGeneration) return
      await secureStorage.remove({ key: SESSION_KEY }).catch(() => {})
    })
  }
  return generation === sessionGeneration
}

export async function clearSocialSession() {
  const generation = invalidatePendingSessionOperations()
  await clearStoredSocialSession(generation)
  return generation
}

export async function clearSocialIdentityForPairingReset() {
  const generation = invalidatePendingSessionOperations()
  await clearStoredSocialSession(generation)
  if (isNativeStorage()) {
    await runSecureStorageOperation(async () => {
      if (generation !== sessionGeneration) return
      await secureStorage.remove({ key: DEVICE_KEY }).catch(() => {})
      await secureStorage.remove({ key: SIGNED_OUT_KEY }).catch(() => {})
    })
  } else {
    if (generation !== sessionGeneration) return
    try {
      localStorage.removeItem(WEB_DEVICE_KEY)
      localStorage.removeItem(SIGNED_OUT_KEY)
    } catch {}
  }
}

async function socialDeviceKey(generation: number) {
  assertSessionGeneration(generation)
  if (isNativeStorage()) {
    return runSecureStorageOperation(async () => {
      assertSessionGeneration(generation)
      const stored = await secureStorage.get({ key: DEVICE_KEY }).catch(() => ({ value: null }))
      assertSessionGeneration(generation)
      if (stored.value) return stored.value
      const value = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
      await secureStorage.set({ key: DEVICE_KEY, value })
      if (generation !== sessionGeneration) {
        await secureStorage.remove({ key: DEVICE_KEY }).catch(() => {})
        throw staleSessionOperationError()
      }
      return value
    })
  }
  assertSessionGeneration(generation)
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

async function refreshSession(socialUrl: string, session: StoredSocialSession, generation: number) {
  const tokens = await jsonRequest<SocialTokenPair>(`${socialUrl}/auth/refresh`, {
    method: 'POST',
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  return saveSession(socialUrl, tokens, generation)
}

async function enrollCompanion(options: SocialAuthOptions, generation: number) {
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
        deviceKey: await socialDeviceKey(generation),
        deviceName: 'Ritim Telefon',
      }),
    },
  )
  return saveSession(options.socialUrl, tokens, generation)
}

async function ensure(options: SocialAuthOptions, generation: number) {
  if (await readSignedOut()) return ''
  assertSessionGeneration(generation)
  let session = await loadSession()
  assertSessionGeneration(generation)
  if (session?.server !== options.socialUrl) {
    await clearStoredSocialSession(generation)
    assertSessionGeneration(generation)
    session = null
  }
  if (session?.accessToken && session.accessExpiresAt > Date.now() + 60_000) {
    assertSessionGeneration(generation)
    return session.accessToken
  }
  if (session?.refreshToken && session.refreshExpiresAt > Date.now()) {
    try {
      return (await refreshSession(options.socialUrl, session, generation)).accessToken
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        assertSessionGeneration(generation)
        await clearStoredSocialSession(generation)
        assertSessionGeneration(generation)
      }
      else throw error
    }
  }
  if (!options.isCompanion || !options.pairingToken) return ''
  return (await enrollCompanion(options, generation)).accessToken
}

export function ensureSocialAccessToken(options: SocialAuthOptions) {
  const contextKey = socialAuthContextKey(options)
  if (ensurePromise && ensurePromiseKey !== contextKey) invalidatePendingSessionOperations()
  if (!ensurePromise) {
    const generation = sessionGeneration
    const currentEnsure = ensure(options, generation).finally(() => {
      if (ensurePromise === currentEnsure) {
        ensurePromise = undefined
        ensurePromiseKey = ''
      }
    })
    ensurePromise = currentEnsure
    ensurePromiseKey = contextKey
  }
  return ensurePromise
}

export async function invalidateSocialAccessToken() {
  const generation = sessionGeneration
  const session = await loadSession()
  if (!session || generation !== sessionGeneration) return
  const invalidated = { ...session, accessToken: '', accessExpiresAt: 0 }
  await persistStoredSession(invalidated, generation)
}

export async function getSocialAccount(options: SocialAuthOptions) {
  const accessToken = await ensureSocialAccessToken(options)
  if (!accessToken) {
    return { authenticated: false, currentDeviceId: '', devices: [] }
  }
  try {
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
  } catch (error) {
    const status = (error as { status?: number }).status
    if (![404, 503].includes(Number(status))) throw error
    const session = await loadSession()
    if (!session?.user || !session.device?.id) throw error
    return {
      authenticated: true,
      user: {
        id: session.user.id,
        displayName: session.user.displayName,
        handle: session.user.handle || '@ritim',
        initials: session.user.initials || sessionInitials(session.user.displayName),
        avatarUrl: session.user.avatarUrl,
        avatarTone: Number(session.user.avatarTone) || 0,
      },
      currentDeviceId: session.device.id,
      devices: [{
        id: session.device.id,
        role: session.device.role,
        name: session.device.role === 'companion' ? 'Ritim Telefon' : 'Ritim PC',
        createdAt: new Date().toISOString(),
      }],
      limited: true,
      warning: 'Cihaz listesi sunucusu henüz hazır değil; bu cihazdaki güvenli oturum gösteriliyor.',
    }
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
  const operationGeneration = sessionGeneration
  const accessToken = await ensureSocialAccessToken(options).catch(() => '')
  if (accessToken) {
    await fetch(`${options.socialUrl}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12_000),
    }).catch(() => {})
  }
  if (operationGeneration !== sessionGeneration) return
  const generation = invalidatePendingSessionOperations()
  await clearStoredSocialSession(generation)
  await setSignedOut(true, generation)
  notifySessionChanged()
}

export async function signOutExistingSocialSession(options: Pick<SocialAuthOptions, 'socialUrl'>) {
  const session = await loadSession()
  const accessToken = session?.server === options.socialUrl ? session.accessToken : ''
  if (!accessToken) return false
  await fetch(`${options.socialUrl}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(1_500),
  }).catch(() => {})
  return true
}

export async function resumeSocialAccount(options: SocialAuthOptions) {
  const generation = invalidatePendingSessionOperations()
  await clearStoredSocialSession(generation)
  await setSignedOut(false, generation)
  assertSessionGeneration(generation)
  const token = await ensureSocialAccessToken(options)
  notifySessionChanged()
  return token
}
