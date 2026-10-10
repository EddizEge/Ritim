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

test('profil tepkisi PostgreSQL bildirimi tercihe, sessize almaya ve okunmamış birleştirmeye uyar', async () => {
  const calls: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    async query(sqlValue: unknown, parameters?: unknown[]) {
      const sql = String(sqlValue)
      calls.push({ sql, parameters })
      if (/select id from ritim\.users where public_id/i.test(sql)) {
        return { rows: [{ id: parameters?.[0] === busyId ? '7' : '9' }], rowCount: 1 }
      }
      if (/as allowed/i.test(sql)) return { rows: [{ allowed: true }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const store = createDurableSocialStore({ connect: async () => client } as never, {} as never)

  await store.saveReaction({ actorId: busyId, targetId: quietId, reaction: '🔥' })

  const notification = calls.find(({ sql }) => /insert into ritim\.social_notifications/i.test(sql))
  assert.ok(notification, 'profil tepkisi bildirim satırı yazmalı')
  assert.match(notification.sql, /'profile_reaction'/)
  assert.doesNotMatch(notification.sql, /message_id/, 'profil tepkisi mesaja bağlı değildir')
  assert.match(notification.sql, /preferences\.reactions_enabled/)
  assert.match(notification.sql, /muted_until > now\(\)/)
  assert.match(
    notification.sql,
    /on conflict \(recipient_id, actor_id\)\s+where kind = 'profile_reaction' and read_at is null\s+do update set body = excluded\.body, created_at = now\(\)/,
  )
  assert.deepEqual(notification.parameters, ['9', '7', '🔥'], 'alıcı hedef, aktör gönderen')
  const reactionIndex = calls.findIndex(({ sql }) => /insert into ritim\.reactions/i.test(sql))
  assert.ok(reactionIndex >= 0 && reactionIndex < calls.indexOf(notification), 'bildirim tepkiyle aynı işlemde yazılır')
})

test('profil tepkisi engel ya da gizlilik nedeniyle reddedilirse bildirim yazılmaz', async () => {
  const calls: string[] = []
  const client = {
    async query(sqlValue: unknown, parameters?: unknown[]) {
      const sql = String(sqlValue)
      calls.push(sql)
      if (/select id from ritim\.users where public_id/i.test(sql)) {
        return { rows: [{ id: parameters?.[0] === busyId ? '7' : '9' }], rowCount: 1 }
      }
      if (/as allowed/i.test(sql)) return { rows: [{ allowed: false }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const store = createDurableSocialStore({ connect: async () => client } as never, {} as never)

  await assert.rejects(
    store.saveReaction({ actorId: busyId, targetId: quietId, reaction: '🔥' }),
    /engellendi/,
  )
  assert.equal(calls.some((sql) => /insert into ritim\.(reactions|social_notifications)/i.test(sql)), false)
  assert.ok(calls.includes('rollback'))
})

test('090 geçişi profile_reaction türünü ve okunmamış tepki indeksini idempotent ekler', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../deploy/pi/postgres/init/090_profile_reaction_notifications.sql', import.meta.url)),
    'utf8',
  )
  assert.ok(migration.startsWith('\\set ON_ERROR_STOP on\n'))
  assert.match(migration, /\nbegin;[\s\S]*\ncommit;\s*$/)
  assert.match(migration, /conrelid = 'ritim\.social_notifications'::regclass[\s\S]*contype = 'c'[\s\S]*attname = 'kind'/)
  assert.match(migration, /drop constraint %I/)
  assert.match(
    migration,
    /add constraint social_notifications_kind_check\s+check \(kind in \('message_request', 'message', 'reaction', 'profile_reaction'\)\)/,
  )
  assert.match(
    migration,
    /create unique index if not exists social_notifications_profile_reaction_unread_idx\s+on ritim\.social_notifications \(recipient_id, actor_id\)\s+where kind = 'profile_reaction' and read_at is null;/,
  )
  const readme = readFileSync(fileURLToPath(new URL('../deploy/pi/README.md', import.meta.url)), 'utf8')
  assert.match(readme, /< postgres\/init\/090_profile_reaction_notifications\.sql/)
})
