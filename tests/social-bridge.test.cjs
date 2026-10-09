const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  LOCAL_SOCIAL_ACTIONS,
  SOCIAL_ACTIONS,
  createSocialActionBridge,
  normalizeSocialAction,
  publicSocialAuthentication,
  sanitizeAckResult,
  sanitizeSocialErrorEvent,
  socialBadgeCount,
} = require('../electron/social-bridge.cjs')

const UUID = '6f1b8f4e-2c3d-4a5b-9c6d-7e8f9a0b1c2d'

function fakeSocket({ connected = true, ack } = {}) {
  const emitted = []
  return {
    connected,
    emitted,
    emit(event, payload, callback) {
      emitted.push({ event, payload, hasCallback: typeof callback === 'function' })
      if (typeof callback === 'function' && ack) ack(event, payload, callback)
    },
  }
}

test('köprü yalnız izinli eylemleri sunucu olaylarına eşler', () => {
  const hubSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'social-hub.cjs'), 'utf8')
  for (const [type, { event, ack }] of Object.entries(SOCIAL_ACTIONS)) {
    assert.match(hubSource, new RegExp(`socket\\.on\\('${event}'`), `${type} → ${event} sunucuda tanımlı olmalı`)
    if (ack) {
      const start = hubSource.indexOf(`socket.on('${event}'`)
      const handlerHead = hubSource.slice(start, start + 260)
      assert.match(handlerHead, /acknowledge/, `${event} ack desteklemeli`)
    }
  }
  for (const type of ['request-response', 'read', 'message-reaction', 'notifications-read', 'room-membership']) {
    assert.ok(SOCIAL_ACTIONS[type], `${type} eksik olay bağlanmalı`)
  }
  for (const type of ['message', 'room-message', 'room-reaction', 'room-membership']) {
    assert.equal(SOCIAL_ACTIONS[type].ack, true)
  }
  assert.deepEqual([...LOCAL_SOCIAL_ACTIONS].sort(), ['device-notifications', 'reconnect', 'sign-in', 'sign-out'])
  for (const forbidden of ['join', 'profile', 'room-playback:update', 'room-playback:result', 'clock:ping', '__proto__', 'constructor', 'toString']) {
    assert.deepEqual(normalizeSocialAction(forbidden, {}), { ok: false, code: 'unknown_action' })
  }
  assert.deepEqual(normalizeSocialAction(undefined, {}), { ok: false, code: 'unknown_action' })
})

test('yük doğrulaması düz nesne ister ve sunucu sınırlarına uyar', () => {
  for (const payload of [[], 'metin', 42, new Date(), new Map()]) {
    assert.deepEqual(normalizeSocialAction('read', payload), { ok: false, code: 'invalid_payload' })
  }
  assert.deepEqual(normalizeSocialAction('read', {}), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('read', { targetUserId: 'x'.repeat(81) }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('read', { targetUserId: { id: 'a' } }), { ok: false, code: 'invalid_payload' })

  const message = normalizeSocialAction('message', { targetUserId: ' user-1 ', text: '  merhaba  ', clientMessageId: UUID, extra: 'atılır' })
  assert.equal(message.ok, true)
  assert.equal(message.event, 'social:message')
  assert.deepEqual(message.payload, { targetUserId: 'user-1', text: 'merhaba', clientMessageId: UUID })
  assert.deepEqual(normalizeSocialAction('message', { targetUserId: 'u', text: 'a'.repeat(501) }), { ok: false, code: 'message_too_long' })
  assert.equal(normalizeSocialAction('message', { targetUserId: 'u', text: 'a'.repeat(500) }).ok, true)
  assert.deepEqual(normalizeSocialAction('message', { targetUserId: 'u', text: '   ' }), { ok: false, code: 'invalid_payload' })
  const generatedId = normalizeSocialAction('message', { targetUserId: 'u', text: 'selam', clientMessageId: 'kötü' })
  assert.match(generatedId.payload.clientMessageId, /^[0-9a-f-]{36}$/)

  assert.deepEqual(normalizeSocialAction('room-message', { roomId: 'r', text: 'a'.repeat(281) }), { ok: false, code: 'room_message_too_long' })
  assert.equal(normalizeSocialAction('room-message', { roomId: 'r', text: 'a'.repeat(280) }).ok, true)
  assert.deepEqual(normalizeSocialAction('room-reaction', { roomId: 'r', reaction: '😂' }), { ok: false, code: 'invalid_payload' })
  assert.equal(normalizeSocialAction('room-reaction', { roomId: 'r', reaction: '🎵' }).ok, true)
  assert.deepEqual(normalizeSocialAction('message-reaction', { targetUserId: 'u', messageId: 'm', reaction: '🎵' }), { ok: false, code: 'invalid_payload' })
  assert.equal(normalizeSocialAction('message-reaction', { targetUserId: 'u', messageId: 'm', reaction: '😂' }).ok, true)
  assert.deepEqual(normalizeSocialAction('request-response', { requesterUserId: 'u', action: 'ignore' }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('request-response', { requesterUserId: 'u', action: 'accept' }).payload, { requesterUserId: 'u', action: 'accept' })
  assert.deepEqual(normalizeSocialAction('privacy', { profileVisibility: 'herkes', listeningVisibility: 'hidden' }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('notification-preferences', { messagesEnabled: 'evet', reactionsEnabled: true }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('reaction', { targetUserId: 'u' }).payload, { targetUserId: 'u', reaction: '♥' })
  assert.deepEqual(normalizeSocialAction('reaction', { targetUserId: 'u', reaction: 'x'.repeat(9) }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('listening', {}).payload, { targetUserId: '' })
  assert.deepEqual(normalizeSocialAction('notifications-read', undefined).payload, {})
  assert.deepEqual(normalizeSocialAction('create-room', { title: 'renderer başlığı' }).payload, {})
  assert.deepEqual(normalizeSocialAction('device-notifications', { enabled: 'true' }), { ok: false, code: 'invalid_payload' })
  assert.equal(normalizeSocialAction('device-notifications', { enabled: false }).local, true)

  assert.deepEqual(normalizeSocialAction('report', { targetUserId: 'u', reason: 'ab' }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('report', { targetUserId: 'u', reason: 'Spam', detail: 'd'.repeat(2001) }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(normalizeSocialAction('report', { targetUserId: 'u', reason: 'Spam' }).payload, {
    targetUserId: 'u',
    reason: 'Spam',
    detail: '',
    messageId: '',
  })
})

test('ack destekleyen olay sonucu Promise olarak ve yalnız güvenli alanlarla döner', async () => {
  const socket = fakeSocket({
    ack: (_event, _payload, callback) => callback({ ok: true, duplicate: false, status: 'joined', playback: { secret: true }, token: 'gizli' }),
  })
  const bridge = createSocialActionBridge({ getSocket: () => socket })
  const result = await bridge.dispatch('room-membership', { roomId: 'room-1' })
  assert.deepEqual(result, { ok: true, duplicate: false, status: 'joined' })
  assert.deepEqual(socket.emitted, [{ event: 'social:room-membership', payload: { roomId: 'room-1' }, hasCallback: true }])

  const rejecting = fakeSocket({ ack: (_event, _payload, callback) => callback({ ok: false, code: 'message_request_pending' }) })
  const rejected = await createSocialActionBridge({ getSocket: () => rejecting })
    .dispatch('message', { targetUserId: 'u', text: 'cevap' })
  assert.deepEqual(rejected, { ok: false, code: 'message_request_pending' })

  assert.deepEqual(sanitizeAckResult(null), { ok: false, code: 'rejected' })
  assert.deepEqual(sanitizeAckResult({ ok: false, code: 'Bad Code <script>' }), { ok: false, code: 'rejected' })
  assert.deepEqual(sanitizeAckResult({ ok: 'yes' }), { ok: false, code: 'rejected' })
})

test('ack gelmezse zaman aşımı, soket yoksa çevrimdışı döner', async () => {
  const silent = fakeSocket()
  const bridge = createSocialActionBridge({ getSocket: () => silent, timeoutMs: 20 })
  assert.deepEqual(await bridge.dispatch('message', { targetUserId: 'u', text: 'selam' }), { ok: false, code: 'timeout' })

  let lateCallback
  const late = fakeSocket({ ack: (_event, _payload, callback) => { lateCallback = callback } })
  const lateResult = await createSocialActionBridge({ getSocket: () => late, timeoutMs: 20 })
    .dispatch('room-message', { roomId: 'r', text: 'selam' })
  assert.deepEqual(lateResult, { ok: false, code: 'timeout' })
  assert.doesNotThrow(() => lateCallback({ ok: true }))

  const offline = createSocialActionBridge({ getSocket: () => fakeSocket({ connected: false }) })
  assert.deepEqual(await offline.dispatch('message', { targetUserId: 'u', text: 'selam' }), { ok: false, code: 'offline' })
  assert.deepEqual(await offline.dispatch('read', { targetUserId: 'u' }), { ok: false, code: 'offline' })
  const missing = createSocialActionBridge({ getSocket: () => null })
  assert.deepEqual(await missing.dispatch('block', { targetUserId: 'u' }), { ok: false, code: 'offline' })

  const throwing = createSocialActionBridge({ getSocket: () => ({ connected: true, emit() { throw new Error('closed') } }) })
  assert.deepEqual(await throwing.dispatch('message', { targetUserId: 'u', text: 'selam' }), { ok: false, code: 'offline' })
})

test('ack istemeyen olaylar hemen gönderilir; geçersiz istek sokete ulaşmaz', async () => {
  const socket = fakeSocket()
  const bridge = createSocialActionBridge({ getSocket: () => socket })
  assert.deepEqual(await bridge.dispatch('read', { targetUserId: 'u' }), { ok: true, acknowledged: false })
  assert.deepEqual(await bridge.dispatch('request-response', { requesterUserId: 'u', action: 'reject' }), { ok: true, acknowledged: false })
  assert.deepEqual(socket.emitted.map((item) => [item.event, item.hasCallback]), [
    ['social:read', false],
    ['social:request-response', false],
  ])
  assert.deepEqual(await bridge.dispatch('read', { targetUserId: '' }), { ok: false, code: 'invalid_payload' })
  assert.deepEqual(await bridge.dispatch('sign-in', {}), { ok: false, code: 'unknown_action' })
  assert.deepEqual(await bridge.emit({ ok: true, local: true, type: 'sign-out' }), { ok: false, code: 'unknown_action' })
  assert.equal(socket.emitted.length, 2)
})

test('sekme rozeti okunmamış konuşmalar ile gelen istekleri sayar', () => {
  assert.equal(socialBadgeCount(undefined), 0)
  assert.equal(socialBadgeCount({
    unreadCounts: { a: 2, b: 0, c: 3, d: -4, e: Number.NaN },
    messageRequests: [{ direction: 'incoming' }, { direction: 'outgoing' }, { direction: 'incoming' }],
    users: [{ presence: 'online' }, { presence: 'online' }],
  }), 7)
})

test('renderera giden kimlik özeti cihaz ve token bilgisi taşımaz', () => {
  const summary = publicSocialAuthentication({
    configured: true,
    required: true,
    authenticated: true,
    user: { id: 'acc', displayName: 'Ediz', handle: '@ediz', initials: 'E', avatarTone: 2, accessToken: 'x' },
    device: { id: 'device-1', role: 'desktop' },
    accessToken: 'gizli',
    refreshToken: 'gizli',
  })
  assert.deepEqual(summary, {
    configured: true,
    required: true,
    authenticated: true,
    user: { id: 'acc', displayName: 'Ediz', handle: '@ediz', initials: 'E', avatarUrl: undefined, avatarTone: 2 },
  })
  assert.doesNotMatch(JSON.stringify(summary), /gizli|device-1|Token/)
  assert.deepEqual(publicSocialAuthentication(undefined), { configured: false, required: false, authenticated: false, user: undefined })
})

test('sunucu hata olayı yalnız kod ve olay adıyla iletilir', () => {
  assert.deepEqual(sanitizeSocialErrorEvent({ code: 'room_full', event: 'listening', retryAfter: 3, stack: 'x' }), {
    kind: 'error',
    code: 'room_full',
    event: 'listening',
  })
  assert.deepEqual(sanitizeSocialErrorEvent('boom'), { kind: 'error', code: 'unknown', event: '' })
})
