import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDurableSocialStore } from '../server/social-store'

const viewerId = '10000000-0000-4000-8000-000000000001'
const targetId = '20000000-0000-4000-8000-000000000002'

function fakePool() {
  const calls: Array<{ sql: string; parameters?: unknown[] }> = []
  const query = async (sqlValue: unknown, parameters?: unknown[]) => {
    const sql = String(sqlValue)
    calls.push({ sql, parameters })
    if (/^begin$|^commit$|^rollback$|^set local statement_timeout/i.test(sql.trim())) {
      return { rows: [], rowCount: 0 }
    }
    if (/select id from ritim\.users where public_id/i.test(sql)) {
      return { rows: [{ id: '41' }], rowCount: 1 }
    }
    if (/from ritim\.notification_preferences preferences/i.test(sql)) {
      return {
        rows: [{
          account_key: viewerId,
          messages_enabled: false,
          reactions_enabled: true,
        }],
        rowCount: 1,
      }
    }
    if (/from ritim\.conversation_members viewer_member/i.test(sql)) {
      const user = {
        viewer_key: viewerId,
        target_key: targetId,
        target_public_id: targetId,
        target_display_name: 'Çevrimdışı Kullanıcı',
        target_handle: '@cevrimdisi',
        target_initials: 'ÇK',
        target_avatar_url: null,
        target_avatar_tone: 4,
      }
      return {
        rows: [{ ...user, kind: 'mute' }, { ...user, kind: 'block' }],
        rowCount: 2,
      }
    }
    if (/with report_rows as/i.test(sql)) {
      return {
        rows: [{
          reporter_key: viewerId,
          target_user_id: targetId,
          display_name: 'Çevrimdışı Kullanıcı',
          reason: 'Spam',
          created_at: new Date('2026-08-23T10:00:00.000Z'),
          total: '3',
        }],
        rowCount: 1,
      }
    }
    if (/insert into ritim\.notification_preferences/i.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Beklenmeyen test sorgusu: ${sql}`)
  }
  const client = { query, release() {} }
  return {
    calls,
    pool: {
      query,
      connect: async () => client,
    },
  }
}

test('kalıcı Beta 1 snapshotı çevrimdışı moderasyon profillerini ve güvenli rapor özetini döndürür', async () => {
  const { pool } = fakePool()
  const store = createDurableSocialStore(pool as never, {} as never)

  const moderation = await store.loadModerationState([viewerId])
  assert.deepEqual([...moderation.muted.get(viewerId)!], [targetId])
  assert.deepEqual([...moderation.blocked.get(viewerId)!], [targetId])
  assert.deepEqual(moderation.mutedUsers.get(viewerId), [{
    id: targetId,
    displayName: 'Çevrimdışı Kullanıcı',
    handle: '@cevrimdisi',
    initials: 'ÇK',
    avatarUrl: undefined,
    avatarTone: 4,
    presence: 'offline',
    currentTrack: undefined,
    reactionCount: 0,
    lastReaction: undefined,
  }])
  assert.deepEqual(moderation.blockedUsers.get(viewerId), moderation.mutedUsers.get(viewerId))

  const summaries = await store.loadReportSummaries([viewerId])
  assert.deepEqual(summaries.get(viewerId), {
    total: 3,
    recent: [{
      targetUserId: targetId,
      displayName: 'Çevrimdışı Kullanıcı',
      reason: 'Spam',
      createdAt: Date.parse('2026-08-23T10:00:00.000Z'),
      status: 'received',
    }],
  })
  assert.deepEqual(Object.keys(summaries.get(viewerId)!.recent[0]).sort(), [
    'createdAt',
    'displayName',
    'reason',
    'status',
    'targetUserId',
  ])
})

test('sunucu yalnız hesap bildirim tercihlerini saklar ve cihaz iznini false döndürür', async () => {
  const { pool, calls } = fakePool()
  const store = createDurableSocialStore(pool as never, {} as never)

  const loaded = await store.loadNotificationPreferences([viewerId])
  assert.deepEqual(loaded.get(viewerId), {
    messagesEnabled: false,
    reactionsEnabled: true,
    deviceEnabled: false,
  })

  await store.updateNotificationPreferences(viewerId, {
    messagesEnabled: false,
    reactionsEnabled: true,
    deviceEnabled: true,
  })
  const insert = calls.find(({ sql }) => /insert into ritim\.notification_preferences/i.test(sql))
  assert.ok(insert)
  assert.doesNotMatch(insert.sql, /device_enabled/i)
  assert.deepEqual(insert.parameters, ['41', false, true])
})

test('070 geçişi reports tablosunun yalnız güvenli özet sütunlarına SELECT verir', () => {
  const migrationPath = fileURLToPath(new URL('../deploy/pi/postgres/init/070_beta1_settings.sql', import.meta.url))
  const migration = readFileSync(migrationPath, 'utf8')
  assert.match(
    migration,
    /grant select \(reporter_id, reported_user_id, reason, created_at\)\s+on ritim\.reports to ritim_app;/i,
  )
  assert.match(migration, /revoke select on ritim\.reports from ritim_app;/i)
  assert.doesNotMatch(migration, /grant select on ritim\.reports/i)
  assert.doesNotMatch(migration, /detail|message_id|status\)/i)
})
