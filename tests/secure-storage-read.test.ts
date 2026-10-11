import assert from 'node:assert/strict'
import test from 'node:test'
import { Capacitor } from '@capacitor/core'

import { createMobilePairingPersistence, type MobilePairingSecureStorage } from '../src/mobileConfig.ts'
import { SecureStorageUnavailableError, isSecureStorageUnavailable, readSecureValue } from '../src/secureStorageRead.ts'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

// Like RitimSecureStoragePlugin: a rejected get means "Keystore unavailable
// right now"; the record itself stays.
class FlakySecureStorage implements MobilePairingSecureStorage {
  readonly values = new Map<string, string>()
  failingGets = 0
  gets = 0
  sets: string[] = []
  removes: string[] = []

  async get({ key }: { key: string }) {
    this.gets += 1
    if (this.failingGets > 0) {
      this.failingGets -= 1
      throw Object.assign(new Error('Android güvenli depolama şu an okunamadı.'), { code: 'SECURE_STORAGE_UNAVAILABLE' })
    }
    return { value: this.values.get(key) ?? null }
  }

  async set({ key, value }: { key: string; value: string }) {
    this.sets.push(key)
    this.values.set(key, value)
  }

  async remove({ key }: { key: string }) {
    this.removes.push(key)
    this.values.delete(key)
  }
}

const NO_WAIT = [0, 0]

test('geçici okuma hatası yeniden denenir; sonunda okunursa değer döner', async () => {
  const secure = new FlakySecureStorage()
  secure.values.set('k', 'değer')
  secure.failingGets = 2
  assert.equal(await readSecureValue((options) => secure.get(options), 'k', NO_WAIT), 'değer')
  assert.equal(secure.gets, 3)
})

test('kayıt yoksa null; kalıcı bozuk kayıt atıldıysa (discarded) yine null', async () => {
  assert.equal(await readSecureValue(async () => ({ value: null }), 'k', NO_WAIT), null)
  assert.equal(await readSecureValue(async () => ({ value: null, discarded: true }), 'k', NO_WAIT), null)
})

test('hata sürerse "kayıt yok" denmez: SecureStorageUnavailableError atılır', async () => {
  const secure = new FlakySecureStorage()
  secure.failingGets = 99
  await assert.rejects(
    readSecureValue((options) => secure.get(options), 'pairing.token.v2', NO_WAIT),
    (error: unknown) => error instanceof SecureStorageUnavailableError && isSecureStorageUnavailable(error) && error.key === 'pairing.token.v2',
  )
  assert.equal(secure.gets, 3)
  assert.equal(isSecureStorageUnavailable({ code: 'SECURE_STORAGE_UNAVAILABLE' }), true)
  assert.equal(isSecureStorageUnavailable(new Error('x')), false)
})

function pairedPersistence() {
  const local = new MemoryStorage()
  const secure = new FlakySecureStorage()
  let transaction = 0
  const persistence = createMobilePairingPersistence({
    native: true,
    local,
    secure,
    nextTransactionId: () => `tx-${++transaction}`,
    secureRetryDelaysMs: NO_WAIT,
  })
  return { local, secure, persistence }
}

const pairing = {
  syncUrl: 'http://192.168.1.28:8787',
  room: 'EDIZ-4821',
  token: 'pairing_token_123456789012345678901234',
  installationId: 'ritim-pc123',
  computerName: 'Ediz PC',
}

test('telefon eşlemesi: Keystore kısa süre okunamazsa eşleme yine okunur', async () => {
  const { secure, persistence } = pairedPersistence()
  await persistence.save({ version: 2, pairedAt: 1, ...pairing })
  secure.failingGets = 1
  const read = await persistence.read()
  assert.equal(read?.token, pairing.token)
  assert.equal(read?.installationId, pairing.installationId)
})

test('telefon eşlemesi: Keystore okunamıyorsa eşleme "yok" sayılmaz, silinmez ve üzerine yazılmaz', async () => {
  const { local, secure, persistence } = pairedPersistence()
  await persistence.save({ version: 2, pairedAt: 1, ...pairing })
  const secureBefore = secure.values.get('pairing.token.v2')
  const metadataBefore = local.getItem('ritim-mobile-pairing-v2')
  secure.sets = []
  secure.failingGets = 99
  await assert.rejects(persistence.read(), isSecureStorageUnavailable)
  assert.equal(secure.values.get('pairing.token.v2'), secureBefore)
  assert.equal(local.getItem('ritim-mobile-pairing-v2'), metadataBefore)
  assert.deepEqual(secure.sets, [])
  assert.deepEqual(secure.removes, [])
  secure.failingGets = 0
  assert.equal((await persistence.read())?.token, pairing.token)
})

test('sosyal oturum: Keystore okunamıyorsa yeni cihaz anahtarı üretilmez, çıkış kararı yok sayılmaz', async (context) => {
  const secure = new FlakySecureStorage()
  const originalNativePlatform = Capacitor.isNativePlatform
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  const originalSecureStorage = (globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage
  const requests: string[] = []
  Capacitor.isNativePlatform = () => true
  ;(globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage = secure
  ;(globalThis as typeof globalThis & { window?: unknown }).window = new EventTarget()
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    throw new Error(`Beklenmeyen test isteği: ${String(input)}`)
  }
  context.after(() => {
    Capacitor.isNativePlatform = originalNativePlatform
    globalThis.fetch = originalFetch
    ;(globalThis as typeof globalThis & { window?: unknown }).window = originalWindow
    ;(globalThis as typeof globalThis & { __ritimSecureStorage?: unknown }).__ritimSecureStorage = originalSecureStorage
  })

  const auth = await import('../src/social/auth')
  const options = {
    socialUrl: 'https://social.test',
    syncUrl: 'https://sync.test',
    pairingToken: 'pairing_token_123456789012345678901234',
    isCompanion: true,
  }
  secure.values.set('social.device.v1', 'kayitli-cihaz-anahtari')
  secure.values.set('social.signed-out.v1', '1')
  secure.failingGets = 99

  await assert.rejects(auth.ensureSocialAccessToken(options), isSecureStorageUnavailable)
  // Neither a new companion enrollment nor a new device key.
  assert.deepEqual(requests, [])
  assert.deepEqual(secure.sets, [])
  assert.equal(secure.values.get('social.device.v1'), 'kayitli-cihaz-anahtari')

  // Readable again: the explicit sign-out is still honoured.
  secure.failingGets = 0
  assert.equal(await auth.ensureSocialAccessToken(options), '')
  assert.deepEqual(requests, [])
})
