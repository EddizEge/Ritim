import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDurableSocialStore, NOTIFICATION_LIMIT_PER_ACCOUNT } from '../server/social-store'

const busyId = '10000000-0000-4000-8000-000000000001'
const quietId = '20000000-0000-4000-8000-000000000002'

test('bildirim anlık görüntüsü alıcı başına en yeni kayıtlarla sınırlanır', async () => {
  const calls: Array<{ sql: string; parameters?: unknown[] }> = []
  const row = (recipientKey: string, index: number) => ({
    public_id: `${recipientKey}-${index}`,
    recipient_key: recipientKey,
    actor_key: null,
    kind: 'message',
    message_public_id: null,
    body: `bildirim ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 10, 12, 0, 0) - index * 1_000),
    read_at: null,
  })
  const pool = {
    async query(sqlValue: unknown, parameters?: unknown[]) {
      const sql = String(sqlValue)
      calls.push({ sql, parameters })
      // The database applies the per-recipient rank; emulate its output.
      return {
        rows: [
          ...Array.from({ length: NOTIFICATION_LIMIT_PER_ACCOUNT }, (_value, index) => row(busyId, index)),
          row(quietId, 0),
        ],
      }
    },
  }
  const store = createDurableSocialStore(pool as never, {} as never)

  const notifications = await store.loadNotifications([busyId, quietId])

  assert.equal(notifications.get(busyId)?.length, NOTIFICATION_LIMIT_PER_ACCOUNT)
  assert.equal(notifications.get(quietId)?.length, 1, 'yoğun hesap diğer hesabın bildirimini dışarıda bırakmamalı')
  assert.equal(calls.length, 1)
  const [{ sql, parameters }] = calls
  assert.match(sql, /row_number\(\) over \(\s*partition by notification\.recipient_id/i)
  assert.match(sql, /notification_rank <= \$2/)
  assert.doesNotMatch(sql, /limit 100/i, 'tüm hesaplar için ortak limit kalmamalı')
  assert.deepEqual(parameters, [[busyId, quietId], NOTIFICATION_LIMIT_PER_ACCOUNT])
})

test('bellek modu ve PostgreSQL aynı hesap başı bildirim sınırını kullanır', () => {
  const hubSource = readFileSync(
    fileURLToPath(new URL('../electron/social-hub.cjs', import.meta.url)),
    'utf8',
  )
  assert.equal(NOTIFICATION_LIMIT_PER_ACCOUNT, 100)
  assert.match(hubSource, new RegExp(`const NOTIFICATION_LIMIT_PER_ACCOUNT = ${NOTIFICATION_LIMIT_PER_ACCOUNT}\\b`))
  assert.match(hubSource, /selected\.slice\(0, NOTIFICATION_LIMIT_PER_ACCOUNT\)/)
})
