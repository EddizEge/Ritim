import assert from 'node:assert/strict'
import test from 'node:test'
import { createSocialOutbox, outboxStatusText, pendingEntriesFor } from '../src/social/socialOutbox'
import type { SocialSendResult } from '../src/social/types'

function deferred() {
  let resolve!: (value: SocialSendResult) => void
  const promise = new Promise<SocialSendResult>((done) => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function setup() {
  const calls: Array<{ userId: string; text: string; clientMessageId: string; reply: ReturnType<typeof deferred> }> = []
  let ids = 0
  const outbox = createSocialOutbox({
    send: (userId, text, clientMessageId) => {
      const reply = deferred()
      calls.push({ userId, text, clientMessageId, reply })
      return reply.promise
    },
    now: () => 1_000,
    newId: () => `client-${++ids}`,
  })
  return { outbox, calls }
}

test('iyimser gönderim: balon hemen "Gönderiliyor…", ack gelince "İletildi"', async () => {
  const { outbox, calls } = setup()
  let notified = 0
  outbox.subscribe(() => { notified += 1 })
  const entry = outbox.send('ali', '  Selam  ')
  assert.ok(entry)
  assert.equal(entry.text, 'Selam')
  assert.equal(outbox.getSnapshot()[0].status, 'sending')
  assert.equal(outboxStatusText(outbox.getSnapshot()[0]), 'Gönderiliyor…')
  assert.deepEqual(calls.map((call) => [call.userId, call.text, call.clientMessageId]), [['ali', 'Selam', 'client-1']])
  calls[0].reply.resolve({ ok: true, duplicate: false })
  await flush()
  assert.equal(outbox.getSnapshot()[0].status, 'sent')
  assert.equal(outboxStatusText(outbox.getSnapshot()[0]), 'şimdi · İletildi')
  assert.ok(notified >= 2)
  assert.equal(outbox.send('ali', '   '), null)
  assert.equal(calls.length, 1)
})

test('başarısız gönderim metni korur; Tekrar dene AYNI clientMessageId ile gönderir', async () => {
  const { outbox, calls } = setup()
  outbox.send('ali', 'Odayı açınca haber veririm')
  calls[0].reply.resolve({ ok: false, code: 'timeout' })
  await flush()
  const failed = outbox.getSnapshot()[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.code, 'timeout')
  assert.equal(failed.text, 'Odayı açınca haber veririm')
  assert.equal(outboxStatusText(failed), 'Gönderilemedi')

  assert.equal(outbox.retry('client-1'), true)
  assert.equal(outbox.getSnapshot()[0].status, 'sending')
  assert.equal(outbox.retry('client-1'), false)
  assert.equal(calls[1].clientMessageId, 'client-1')
  assert.equal(calls[1].text, 'Odayı açınca haber veririm')
  // The first attempt reached the server after all: it reports a duplicate.
  calls[1].reply.resolve({ ok: true, duplicate: true })
  await flush()
  assert.equal(outbox.getSnapshot()[0].status, 'sent')
  assert.equal(outbox.getSnapshot()[0].attempts, 2)
})

test('gönderici hata atsa da balon "Gönderilemedi" olur, metin kaybolmaz', async () => {
  const outbox = createSocialOutbox({ send: async () => { throw new Error('ipc') }, newId: () => 'x' })
  outbox.send('ali', 'kaybolmasın')
  await flush()
  assert.deepEqual(outbox.getSnapshot().map((entry) => [entry.status, entry.text]), [['failed', 'kaybolmasın']])
})

test('sunucu anlık görüntüsü mesajı içerince (id = clientMessageId) balon yerini gerçek mesaja bırakır', async () => {
  const { outbox, calls } = setup()
  outbox.send('ali', 'bir')
  outbox.send('ayse', 'iki')
  calls[0].reply.resolve({ ok: false, code: 'timeout' })
  await flush()
  const conversations = { ali: [{ id: 'client-1', senderId: 'me', text: 'bir', sentAt: 1, reactions: [] }] }
  assert.deepEqual(pendingEntriesFor(outbox.getSnapshot(), 'ali', conversations.ali), [])
  assert.equal(pendingEntriesFor(outbox.getSnapshot(), 'ayse', []).length, 1)
  outbox.reconcile(conversations)
  assert.deepEqual(outbox.getSnapshot().map((entry) => entry.clientMessageId), ['client-2'])
  outbox.clear()
  assert.deepEqual(outbox.getSnapshot(), [])
})

test('sınırda eski iletilmiş balonlar düşer, başarısız olanlar kalır', async () => {
  let ids = 0
  const replies: Array<(value: SocialSendResult) => void> = []
  const outbox = createSocialOutbox({
    send: () => new Promise((resolve) => replies.push(resolve)),
    newId: () => `c${++ids}`,
    limit: 3,
  })
  outbox.send('a', '1')
  outbox.send('a', '2')
  outbox.send('a', '3')
  replies[0]({ ok: false, code: 'offline' })
  replies[1]({ ok: true })
  replies[2]({ ok: true })
  await flush()
  outbox.send('a', '4')
  assert.deepEqual(outbox.getSnapshot().map((entry) => entry.text), ['1', '4'])
})
