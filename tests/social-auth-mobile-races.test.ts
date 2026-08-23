import assert from 'node:assert/strict'
import test from 'node:test'
import { Capacitor } from '@capacitor/core'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

class DelayedSecureStorage {
  values = new Map<string, string>()
  setHistory: Array<{ key: string; value: string }> = []
  private nextSetGate = new Map<string, { started: Deferred<void>; release: Deferred<void> }>()

  delayNextSet(key: string) {
    const gate = { started: deferred<void>(), release: deferred<void>() }
    this.nextSetGate.set(key, gate)
    return gate
  }

  async get({ key }: { key: string }) {
    return { value: this.values.get(key) ?? null }
  }

  async set({ key, value }: { key: string; value: string }) {
    this.setHistory.push({ key, value })
    const gate = this.nextSetGate.get(key)
    if (gate) {
      this.nextSetGate.delete(key)
      gate.started.resolve()
      await gate.release.promise
    }
    this.values.set(key, value)
  }

  async remove({ key }: { key: string }) {
    this.values.delete(key)
  }
}

function options(id: string) {
  return {
    socialUrl: `https://social-${id}.test`,
    syncUrl: `https://sync-${id}.test`,
    pairingToken: `pairing_${id}_token_123456789012345678901234`,
    isCompanion: true,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function tokens(id: string) {
  return {
    accessToken: `${id}-access`,
    expiresIn: 3600,
    refreshToken: `${id}-refresh`,
    refreshExpiresIn: 7200,
    user: { id: `${id}-user`, displayName: `Ritim ${id}` },
    device: { id: `${id}-device`, role: 'companion' as const },
  }
}

test('pairing reset fences delayed Android session, device and refresh writes', async (context) => {
  const storage = new DelayedSecureStorage()
  const originalNativePlatform = Capacitor.isNativePlatform
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  const originalSecureStorage = (globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage
  let refreshGate: { started: Deferred<void>; response: Deferred<Response> } | null = null
  let ticketGate: { token: string; started: Deferred<void>; response: Deferred<Response> } | null = null
  const ticketTokens: string[] = []

  Capacitor.isNativePlatform = () => true
  ;(globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage = storage
  ;(globalThis as typeof globalThis & { window?: unknown }).window = new EventTarget()
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/social/session-ticket')) {
      const authorization = new Headers(init?.headers).get('authorization') || ''
      ticketTokens.push(authorization)
      if (ticketGate && authorization === `Bearer ${ticketGate.token}`) {
        ticketGate.started.resolve()
        return ticketGate.response.promise
      }
      const id = new URL(url).hostname.replace(/^sync-/, '').replace(/\.test$/, '') || 'unknown'
      return response({ ticket: `${id}-ticket` })
    }
    if (url.endsWith('/auth/companion/exchange')) {
      const ticket = String(JSON.parse(String(init?.body || '{}')).ticket || '')
      return response(tokens(ticket.replace(/-ticket$/, '')))
    }
    if (url.endsWith('/auth/refresh') && refreshGate) {
      refreshGate.started.resolve()
      return refreshGate.response.promise
    }
    throw new Error(`Beklenmeyen test isteği: ${url}`)
  }

  context.after(() => {
    Capacitor.isNativePlatform = originalNativePlatform
    globalThis.fetch = originalFetch
    ;(globalThis as typeof globalThis & { window?: unknown }).window = originalWindow
    ;(globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage = originalSecureStorage
  })

  const auth = await import('../src/social/auth')
  const sessionKey = 'social.session.v1'
  const deviceKey = 'social.device.v1'

  const delayedDevice = storage.delayNextSet(deviceKey)
  const staleDeviceEnsure = auth.ensureSocialAccessToken(options('device-old'))
  await delayedDevice.started.promise
  const deviceReset = auth.clearSocialIdentityForPairingReset()
  delayedDevice.release.resolve()
  await assert.rejects(staleDeviceEnsure, (error: Error) => error.name === 'AbortError')
  await deviceReset
  await auth.ensureSocialAccessToken(options('device-new'))
  const staleDeviceValue = storage.setHistory.find((entry) => entry.key === deviceKey)?.value
  assert.ok(staleDeviceValue)
  assert.notEqual(storage.values.get(deviceKey), staleDeviceValue)
  assert.equal(JSON.parse(storage.values.get(sessionKey) || '{}').server, options('device-new').socialUrl)

  await auth.clearSocialIdentityForPairingReset()
  const delayedSession = storage.delayNextSet(sessionKey)
  const staleSessionEnsure = auth.ensureSocialAccessToken(options('session-old'))
  await delayedSession.started.promise
  const sessionReset = auth.clearSocialIdentityForPairingReset()
  delayedSession.release.resolve()
  await assert.rejects(staleSessionEnsure, (error: Error) => error.name === 'AbortError')
  await sessionReset
  await auth.ensureSocialAccessToken(options('session-new'))
  assert.equal(JSON.parse(storage.values.get(sessionKey) || '{}').server, options('session-new').socialUrl)

  await auth.invalidateSocialAccessToken()
  refreshGate = { started: deferred<void>(), response: deferred<Response>() }
  const staleRefresh = auth.ensureSocialAccessToken(options('session-new'))
  await refreshGate.started.promise
  await auth.clearSocialIdentityForPairingReset()
  await auth.ensureSocialAccessToken(options('fresh-pc'))
  refreshGate.response.resolve(response({ message: 'expired' }, 401))
  await assert.rejects(staleRefresh, (error: Error) => error.name === 'AbortError')
  const finalSession = JSON.parse(storage.values.get(sessionKey) || '{}')
  assert.equal(finalSession.server, options('fresh-pc').socialUrl)
  assert.equal(finalSession.accessToken, 'fresh-pc-access')

  await auth.clearSocialIdentityForPairingReset()
  const rotatedBase = options('rotate')
  const oldPairingToken = 'rotate_old_pairing_token_123456789012345678'
  const newPairingToken = 'rotate_new_pairing_token_123456789012345678'
  ticketGate = {
    token: oldPairingToken,
    started: deferred<void>(),
    response: deferred<Response>(),
  }
  const staleEnrollment = auth.ensureSocialAccessToken({ ...rotatedBase, pairingToken: oldPairingToken })
  await ticketGate.started.promise
  const rotatedAccess = await auth.ensureSocialAccessToken({ ...rotatedBase, pairingToken: newPairingToken })
  ticketGate.response.resolve(response({ message: 'old pairing expired' }, 401))
  await assert.rejects(staleEnrollment, (error: Error & { status?: number }) => error.name === 'AbortError' || error.status === 401)
  assert.equal(rotatedAccess, 'rotate-access')
  assert.ok(ticketTokens.includes(`Bearer ${oldPairingToken}`))
  assert.ok(ticketTokens.includes(`Bearer ${newPairingToken}`))
  assert.equal(JSON.parse(storage.values.get(sessionKey) || '{}').accessToken, 'rotate-access')
})
