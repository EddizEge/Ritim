import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMobilePairingPersistence,
  createPairingMutationQueue,
  normalizeComputerName,
  parsePairingLink,
  type MobilePairingSecureStorage,
} from '../src/mobileConfig.ts'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() { return this.values.size }

  clear() { this.values.clear() }

  getItem(key: string) { return this.values.get(key) ?? null }

  key(index: number) { return [...this.values.keys()][index] ?? null }

  removeItem(key: string) { this.values.delete(key) }

  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

class MemorySecureStorage implements MobilePairingSecureStorage {
  readonly values = new Map<string, string>()
  failNextSet = false

  async get({ key }: { key: string }) { return { value: this.values.get(key) ?? null } }

  async set({ key, value }: { key: string; value: string }) {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('keystore unavailable')
    }
    this.values.set(key, value)
  }

  async remove({ key }: { key: string }) { this.values.delete(key) }
}

test('pairing link produces a normalized version 2 record with the PC name', () => {
  const token = 'pairing_token_123456789012345678901234'
  const pairing = parsePairingLink(`http://192.168.1.28:8787/path?room=A3-FINAL-B&token=${token}&installationId=ritim-pc123&computerName=%20Ediz%20%20PC%20`)

  assert.deepEqual({
    version: pairing.version,
    syncUrl: pairing.syncUrl,
    room: pairing.room,
    token: pairing.token,
    installationId: pairing.installationId,
    computerName: pairing.computerName,
  }, {
    version: 2,
    syncUrl: 'http://192.168.1.28:8787',
    room: 'A3-FINAL-B',
    token,
    installationId: 'ritim-pc123',
    computerName: 'Ediz PC',
  })
  assert.ok(pairing.pairedAt > 0)

  const nested = parsePairingLink(`ritim://pair?url=${encodeURIComponent('https://sync.example.test/?room=NESTED&token=nested_pairing_token_1234567890123456&computerName=Ev-PC')}`)
  assert.equal(nested.syncUrl, 'https://sync.example.test')
  assert.equal(nested.computerName, 'Ev-PC')
  assert.match(nested.installationId, /^ritim-/)
})

test('computer name is safe, bounded and has a useful fallback', () => {
  assert.equal(normalizeComputerName('\u0000  Ofis\n PC  '), 'Ofis PC')
  assert.equal(normalizeComputerName('x'.repeat(120)).length, 80)
  assert.equal(normalizeComputerName(''), 'Ritim PC')
})

test('pairing parser rejects unsafe or incomplete links', () => {
  assert.throws(() => parsePairingLink('ftp://example.test/?room=room&token=pairing_token_123456789012345678901234'), /http veya https/i)
  assert.throws(() => parsePairingLink('https://example.test/?room=room'), /güvenlik anahtarı/i)
  assert.throws(() => parsePairingLink('https://example.test/?room=room&token=short'), /geçersiz/i)
  assert.throws(() => parsePairingLink(`https://example.test/?room=room&token=pairing_token_123456789012345678901234&installationId=wrong`), /PC kimliği/i)
})

test('legacy web pairing migrates once and reset clears account-scoped cache', async () => {
  const storage = new MemoryStorage()
  const persistence = createMobilePairingPersistence({ native: false, local: storage })
  storage.setItem('ritim-sync-url', 'http://127.0.0.1:8787')
  storage.setItem('ritim-room', 'LEGACY-ROOM')
  const legacyToken = 'legacy_pairing_token_123456789012345678'
  storage.setItem('ritim-pairing-token', legacyToken)
  storage.setItem('ritim-player-cache-v2', '{"version":2}')
  storage.setItem('ritim-social-phone-id:old-account', 'old-device')

  const migrated = await persistence.read()

  assert.equal(migrated?.version, 2)
  assert.equal(migrated?.token, legacyToken)
  assert.match(migrated?.installationId || '', /^ritim-/)
  assert.equal(storage.getItem('ritim-sync-url'), null)
  assert.equal(storage.getItem('ritim-room'), null)
  assert.equal(storage.getItem('ritim-pairing-token'), null)
  assert.ok(storage.getItem('ritim-mobile-pairing-v2'))

  await persistence.clear()
  assert.equal(storage.getItem('ritim-mobile-pairing-v2'), null)
  assert.equal(storage.getItem('ritim-player-cache-v2'), null)
  assert.equal(storage.getItem('ritim-social-phone-id:old-account'), null)
})

test('kalıcı tarayıcı deposu yazılamazsa eşleme başarılı görünmez', async () => {
  const storage = new MemoryStorage()
  storage.setItem = () => { throw new Error('quota') }
  const persistence = createMobilePairingPersistence({ native: false, local: storage })
  const pairing = parsePairingLink('http://127.0.0.1:8787/?room=SAFE-ROOM&token=safe_pairing_token_12345678901234567890')

  await assert.rejects(() => persistence.save(pairing), /saklanamadı/i)
  assert.equal(storage.getItem('ritim-mobile-pairing-v2'), null)
})

test('Android pairing stores one authoritative encrypted record and no local raw token', async () => {
  const local = new MemoryStorage()
  const secure = new MemorySecureStorage()
  const persistence = createMobilePairingPersistence({
    native: true,
    local,
    secure,
    nextTransactionId: () => 'transaction-a',
  })
  const pairing = parsePairingLink('http://10.0.0.8:8787/?room=ROOM-A&token=android_pairing_token_12345678901234567&installationId=ritim-pca&computerName=Ev-PC')

  await persistence.save(pairing)

  const metadata = local.getItem('ritim-mobile-pairing-v2') || ''
  const protectedRecord = secure.values.get('pairing.token.v2') || ''
  assert.equal(metadata.includes(pairing.token), false)
  assert.equal(JSON.parse(metadata).transactionId, 'transaction-a')
  assert.equal(JSON.parse(protectedRecord).pairing.token, pairing.token)
  assert.deepEqual(await persistence.read(), pairing)
})

test('Android legacy token is removed only after protected migration succeeds', async () => {
  const local = new MemoryStorage()
  const secure = new MemorySecureStorage()
  local.setItem('ritim-sync-url', 'http://10.0.0.9:8787')
  local.setItem('ritim-room', 'LEGACY-NATIVE')
  local.setItem('ritim-pairing-token', 'legacy_native_pairing_token_1234567890123')
  secure.failNextSet = true
  const persistence = createMobilePairingPersistence({ native: true, local, secure })

  assert.equal(await persistence.read(), null)
  assert.equal(local.getItem('ritim-pairing-token'), 'legacy_native_pairing_token_1234567890123')

  const migrated = await persistence.read()
  assert.equal(migrated?.room, 'LEGACY-NATIVE')
  assert.equal(local.getItem('ritim-pairing-token'), null)
  assert.equal((secure.values.get('pairing.token.v2') || '').includes('legacy_native_pairing_token'), true)
})

test('eşzamanlı Android QR kayıtları token ve metadata değerlerini çapraz karıştırmaz', async () => {
  const local = new MemoryStorage()
  const secure = new MemorySecureStorage()
  const transactionIds = ['transaction-a', 'transaction-b']
  const persistence = createMobilePairingPersistence({
    native: true,
    local,
    secure,
    nextTransactionId: () => transactionIds.shift() || 'unexpected',
  })
  const first = parsePairingLink('http://10.0.0.10:8787/?room=ROOM-A&token=first_android_pairing_token_123456789012&installationId=ritim-pca')
  const second = parsePairingLink('http://10.0.0.11:8787/?room=ROOM-B&token=second_android_pairing_token_12345678901&installationId=ritim-pcb')

  await Promise.all([persistence.save(first), persistence.save(second)])

  const selected = await persistence.read()
  const metadata = JSON.parse(local.getItem('ritim-mobile-pairing-v2') || '{}')
  const protectedRecord = JSON.parse(secure.values.get('pairing.token.v2') || '{}')
  assert.equal(selected?.syncUrl, second.syncUrl)
  assert.equal(selected?.token, second.token)
  assert.equal(metadata.transactionId, 'transaction-b')
  assert.equal(protectedRecord.transactionId, 'transaction-b')
  assert.equal(protectedRecord.pairing.syncUrl, second.syncUrl)
})

test('eşleme iş akışı kuyruğu yavaş ilk QR bitmeden ikinci QRı başlatmaz', async () => {
  const queue = createPairingMutationQueue()
  const events: string[] = []
  let releaseFirst = () => {}
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

  const first = queue.run(async () => {
    events.push('first:start')
    await firstGate
    events.push('first:end')
    return 'first'
  })
  const second = queue.run(async () => {
    events.push('second:start')
    events.push('second:end')
    return 'second'
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(events, ['first:start'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
})
