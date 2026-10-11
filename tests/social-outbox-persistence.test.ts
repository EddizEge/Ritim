import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SOCIAL_OUTBOX_MAX_AGE_MS,
  createSocialOutbox,
  forgetSocialOutbox,
  outboxStatusText,
  pendingEntriesFor,
  socialOutboxKey,
  type OutboxStorage,
} from '../src/social/socialOutbox'
import type { SocialSendResult } from '../src/social/types'

class MemoryStorage implements OutboxStorage {
  data = new Map<string, string>()
  failWrites = false
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.data.set(key, value)
  }
  removeItem(key: string) { this.data.delete(key) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const DAY = 24 * 60 * 60 * 1000

function harness(storage: MemoryStorage, options: { now?: () => number; limit?: number } = {}) {
  const calls: Array<{ userId: string; text: string; clientMessageId: string; resolve: (value: SocialSendResult) => void }> = []
  let ids = 0
  const prefix = Math.random().toString(36).slice(2, 6)
  const outbox = createSocialOutbox({
    send: (userId, text, clientMessageId) => new Promise((resolve) => calls.push({ userId, text, clientMessageId, resolve })),
    storage,
    now: options.now || (() => 1_000_000),
    newId: () => `${prefix}-${++ids}`,
    limit: options.limit,
  })
  return { outbox, calls }
}

function stored(storage: MemoryStorage, account: string) {
  const raw = storage.getItem(socialOutboxKey(account))
  return raw ? (JSON.parse(raw) as { entries: Array<Record<string, unknown>> }).entries : []
}

test('gönderilemeyen ve hâlâ gönderilen mesajlar hesap anahtarında saklanır; iletilen saklanmaz', async () => {
  const storage = new MemoryStorage()
  const { outbox, calls } = harness(storage)
  outbox.setAccount('hesap-a')
  outbox.send('ali', 'bir')
  outbox.send('ali', 'iki')
  outbox.send('ali', 'üç')
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => [entry.text, entry.status]), [['bir', 'sending'], ['iki', 'sending'], ['üç', 'sending']])
  calls[0].resolve({ ok: false, code: 'timeout' })
  calls[1].resolve({ ok: true })
  await flush()
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => [entry.text, entry.status, entry.code]), [['bir', 'failed', 'timeout'], ['üç', 'sending', undefined]])
  calls[2].resolve({ ok: true })
  await flush()
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => entry.text), ['bir'])
})

test('yeniden başlatınca bekleyenler "Gönderilemedi" olarak gelir, kendiliğinden gönderilmez; Tekrar dene aynı clientMessageId ile gider', async () => {
  const storage = new MemoryStorage()
  const first = harness(storage)
  first.outbox.setAccount('hesap-a')
  const failed = first.outbox.send('ali', 'kaybolmasın')!
  const inflight = first.outbox.send('ayse', 'yolda kaldı')!
  first.calls[0].resolve({ ok: false, code: 'offline' })
  await flush()
  // The app is closed while the second message is still "Gönderiliyor…".

  const second = harness(storage)
  second.outbox.setAccount('hesap-a')
  const restored = second.outbox.getSnapshot()
  assert.deepEqual(restored.map((entry) => [entry.clientMessageId, entry.text, entry.status]), [
    [failed.clientMessageId, 'kaybolmasın', 'failed'],
    [inflight.clientMessageId, 'yolda kaldı', 'failed'],
  ])
  assert.equal(restored[1].code, 'interrupted')
  assert.equal(outboxStatusText(restored[1]), 'Gönderilemedi')
  await flush()
  assert.equal(second.calls.length, 0, 'açılışta kendiliğinden gönderilmemeli')

  assert.equal(second.outbox.retry(inflight.clientMessageId), true)
  assert.equal(second.calls.length, 1)
  assert.equal(second.calls[0].clientMessageId, inflight.clientMessageId)
  assert.equal(second.calls[0].text, 'yolda kaldı')
  assert.equal(second.outbox.getSnapshot()[1].attempts, 2)
  second.calls[0].resolve({ ok: true, duplicate: true })
  await flush()
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => entry.clientMessageId), [failed.clientMessageId])
})

test('hesaplar ayrı tutulur: başka hesaba geçince öncekinin mesajları görünmez, geri dönünce gelir', async () => {
  const storage = new MemoryStorage()
  const { outbox, calls } = harness(storage)
  outbox.setAccount('hesap-a')
  outbox.send('ali', 'A hesabından')
  outbox.setAccount('hesap-b')
  assert.deepEqual(outbox.getSnapshot(), [])
  outbox.send('veli', 'B hesabından')
  // A's late answer lands in A's stored outbox, not on B's screen.
  calls[0].resolve({ ok: false, code: 'timeout' })
  await flush()
  assert.deepEqual(outbox.getSnapshot().map((entry) => entry.text), ['B hesabından'])
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => [entry.text, entry.status]), [['A hesabından', 'failed']])
  assert.deepEqual(stored(storage, 'hesap-b').map((entry) => entry.text), ['B hesabından'])
  outbox.setAccount('hesap-a')
  assert.deepEqual(outbox.getSnapshot().map((entry) => [entry.text, entry.status]), [['A hesabından', 'failed']])
})

test('sınırlar: hesap başına en çok 50 mesaj, 7 günden eskiler atılır', () => {
  const storage = new MemoryStorage()
  let clock = 10 * DAY
  const { outbox } = harness(storage, { now: () => clock })
  outbox.setAccount('hesap-a')
  for (let index = 1; index <= 55; index += 1) {
    clock += 1
    outbox.send('ali', `mesaj ${index}`)
  }
  const kept = stored(storage, 'hesap-a')
  assert.equal(kept.length, 50)
  assert.equal(kept[0].text, 'mesaj 6')
  assert.equal(kept[49].text, 'mesaj 55')

  storage.setItem(socialOutboxKey('hesap-c'), JSON.stringify({ version: 1, entries: [
    { clientMessageId: 'eski', userId: 'ali', text: 'eski', createdAt: clock - SOCIAL_OUTBOX_MAX_AGE_MS - 1, status: 'failed', attempts: 1 },
    { clientMessageId: 'taze', userId: 'ali', text: 'taze', createdAt: clock - DAY, status: 'failed', attempts: 1 },
  ] }))
  const reader = harness(storage, { now: () => clock }).outbox
  reader.setAccount('hesap-c')
  assert.deepEqual(reader.getSnapshot().map((entry) => entry.clientMessageId), ['taze'])
})

test('bozuk kayıt uygulamayı çökertmez: okunamayan kayıt silinir, hatalı öğeler atlanır', () => {
  const storage = new MemoryStorage()
  storage.setItem(socialOutboxKey('bozuk-json'), '{not json')
  storage.setItem(socialOutboxKey('yanlis-sekil'), JSON.stringify({ entries: 'x' }))
  storage.setItem(socialOutboxKey('karisik'), JSON.stringify({ version: 1, entries: [
    null,
    42,
    { clientMessageId: '', userId: 'ali', text: 'boş id', createdAt: 900_000, status: 'failed' },
    { clientMessageId: 'a', userId: 'ali', text: '   ', createdAt: 900_000, status: 'failed' },
    { clientMessageId: 'b', userId: 'ali', text: 'tarih yok', status: 'failed' },
    { clientMessageId: 'c', userId: 'ali', text: 'iletildi', createdAt: 900_000, status: 'sent' },
    { clientMessageId: 'd', userId: 'ali', text: 'geçerli', createdAt: 900_000, status: 'failed', attempts: 'x' },
    { clientMessageId: 'd', userId: 'ali', text: 'tekrar', createdAt: 900_001, status: 'failed' },
    { clientMessageId: 'e', userId: { x: 1 }, text: 'nesne kullanıcı', createdAt: 900_000, status: 'failed' },
  ] }))
  const { outbox } = harness(storage)
  for (const account of ['bozuk-json', 'yanlis-sekil']) {
    outbox.setAccount(account)
    assert.deepEqual(outbox.getSnapshot(), [])
    assert.equal(storage.getItem(socialOutboxKey(account)), null)
  }
  outbox.setAccount('karisik')
  assert.deepEqual(outbox.getSnapshot().map((entry) => [entry.clientMessageId, entry.text, entry.attempts]), [['d', 'geçerli', 1]])

  // Storage that throws (quota, disabled storage) only loses persistence.
  const broken = new MemoryStorage()
  broken.getItem = () => { throw new Error('SecurityError') }
  broken.failWrites = true
  const memoryOnly = harness(broken).outbox
  memoryOnly.setAccount('hesap-a')
  assert.ok(memoryOnly.send('ali', 'yine de görünür'))
  assert.deepEqual(memoryOnly.getSnapshot().map((entry) => entry.text), ['yine de görünür'])
})

test('sunucuda görünen mesaj (id = clientMessageId) giden kutusundan ve depodan düşer', async () => {
  const storage = new MemoryStorage()
  const first = harness(storage)
  first.outbox.setAccount('hesap-a')
  const lost = first.outbox.send('ali', 'sunucuya ulaştı ama ack gelmedi')!
  const other = first.outbox.send('ali', 'gerçekten gitmedi')!
  first.calls[0].resolve({ ok: false, code: 'timeout' })
  first.calls[1].resolve({ ok: false, code: 'timeout' })
  await flush()

  const second = harness(storage)
  second.outbox.setAccount('hesap-a')
  const conversations = { ali: [{ id: lost.clientMessageId, senderId: 'ben', text: lost.text, sentAt: 1, reactions: [] }] }
  assert.deepEqual(pendingEntriesFor(second.outbox.getSnapshot(), 'ali', conversations.ali).map((entry) => entry.clientMessageId), [other.clientMessageId])
  second.outbox.reconcile(conversations)
  assert.deepEqual(second.outbox.getSnapshot().map((entry) => entry.clientMessageId), [other.clientMessageId])
  assert.deepEqual(stored(storage, 'hesap-a').map((entry) => entry.clientMessageId), [other.clientMessageId])
})

test('çıkış yapınca o hesabın giden kutusu silinir; geç gelen yanıt kaydı geri getirmez', async () => {
  const storage = new MemoryStorage()
  const { outbox, calls } = harness(storage)
  outbox.setAccount('hesap-b')
  outbox.send('veli', 'B kalsın')
  calls[0].resolve({ ok: false, code: 'offline' })
  outbox.setAccount('hesap-a')
  outbox.send('ali', 'A gidecek')
  await flush()
  outbox.forget('hesap-a')
  assert.deepEqual(outbox.getSnapshot(), [])
  assert.equal(storage.getItem(socialOutboxKey('hesap-a')), null)
  calls[1].resolve({ ok: false, code: 'offline' })
  await flush()
  assert.equal(storage.getItem(socialOutboxKey('hesap-a')), null)
  assert.deepEqual(stored(storage, 'hesap-b').map((entry) => entry.text), ['B kalsın'])

  // The phone does not always know its account at sign-out: every stored
  // outbox on the device goes, other keys stay.
  storage.setItem('ritim.diger.ayar', '1')
  forgetSocialOutbox(undefined, storage)
  assert.equal(storage.getItem(socialOutboxKey('hesap-b')), null)
  assert.equal(storage.getItem('ritim.diger.ayar'), '1')
  storage.setItem(socialOutboxKey('hesap-c'), JSON.stringify({ version: 1, entries: [] }))
  forgetSocialOutbox('hesap-c', storage)
  assert.equal(storage.getItem(socialOutboxKey('hesap-c')), null)
})
