import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  SOCIAL_ACK_EVENTS,
  createSocialAckActions,
  emitSocialAck,
  normalizeSocialAck,
  type SocialAckSocket,
} from '../src/social/socialAckActions'
import { applySocialPending } from '../src/social/socialPending'
import { SOCIAL_ACK_TIMEOUT_MS, isAckHandledSocialError, socialErrorText } from '../src/social/socialShared'
import type { SocialState, SocialUser } from '../src/social/types'

const require = createRequire(import.meta.url)
const { SOCIAL_ACTIONS, DEFAULT_ACK_TIMEOUT_MS } = require('../electron/social-bridge.cjs') as {
  SOCIAL_ACTIONS: Record<string, { event: string; ack: boolean }>
  DEFAULT_ACK_TIMEOUT_MS: number
}

type Answer = (event: string, payload: unknown, callback: (result: unknown) => void) => void

// Stands in for the phone's socket.io client.
function fakeSocket(answer?: Answer, connected = true) {
  const emitted: Array<{ event: string; payload: unknown; hasCallback: boolean }> = []
  const socket: SocialAckSocket & { emitted: typeof emitted } = {
    connected,
    emitted,
    emit(event: string, ...args: unknown[]) {
      const callback = typeof args.at(-1) === 'function' ? args.at(-1) as (result: unknown) => void : undefined
      emitted.push({ event, payload: args[0], hasCallback: Boolean(callback) })
      if (callback && answer) answer(event, args[0], callback)
      return true
    },
  }
  return socket
}

function user(id: string): SocialUser {
  return { id, displayName: id.toUpperCase(), handle: `@${id}`, initials: id[0].toUpperCase(), avatarTone: 1, presence: 'online', reactionCount: 0 }
}

function baseState(patch: Partial<SocialState> = {}): SocialState {
  return {
    connectionStatus: 'online',
    currentUser: user('me'),
    privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' },
    currentDeviceCount: 1,
    companionConnected: true,
    users: [user('ali')],
    rooms: [],
    roomMessages: {},
    roomReactions: {},
    conversations: {
      ali: [{ id: 'm1', senderId: 'ali', text: 'selam', sentAt: 1, reactions: [] }],
    },
    unreadCounts: {},
    messageRequests: [{ userId: 'ali', direction: 'incoming', preview: 'selam', sentAt: 1 }],
    notifications: [{ id: 'n1', kind: 'message', actorId: 'ali', body: 'selam', createdAt: 1, read: false }],
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    mutedUserIds: [],
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
    selectedUserId: '',
    ...patch,
  }
}

// The phone wiring of src/hooks/useSocial.ts: shared actions over its socket.
function phone(socket: ReturnType<typeof fakeSocket>, state = baseState()) {
  const errors: string[] = []
  let renders = 0
  let ids = 0
  const ack = createSocialAckActions({
    send: (type, payload) => emitSocialAck(socket, SOCIAL_ACK_EVENTS[type], payload),
    getState: () => state,
    isOnline: () => socket.connected,
    notifyError: (code) => errors.push(socialErrorText(code)),
    onPendingChange: () => { renders += 1 },
    newId: () => `id-${++ids}`,
  })
  return { ack, errors, view: () => ack.view(state), renders: () => renders }
}

test('telefon ve PC aynı olayları aynı adlarla onaylı gönderir; zaman aşımı ikisinde de 5 sn', () => {
  assert.equal(SOCIAL_ACK_TIMEOUT_MS, 5_000)
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, SOCIAL_ACK_TIMEOUT_MS)
  for (const [type, event] of Object.entries(SOCIAL_ACK_EVENTS)) {
    assert.deepEqual(SOCIAL_ACTIONS[type], { event, ack: true }, type)
    assert.equal(isAckHandledSocialError(event.replace('social:', '')), true, type)
  }
})

test('emitSocialAck: yanıt güvenli alanlarla döner; bağlantı yoksa ve soket hata verirse çevrimdışı', async () => {
  const socket = fakeSocket((_event, _payload, callback) => callback({ ok: true, status: 'joined', token: 'gizli' }))
  assert.deepEqual(await emitSocialAck(socket, 'social:room-membership', { roomId: 'r1' }), { ok: true, status: 'joined' })
  assert.deepEqual(socket.emitted, [{ event: 'social:room-membership', payload: { roomId: 'r1' }, hasCallback: true }])
  const empty = fakeSocket()
  void emitSocialAck(empty, 'social:notifications-read', undefined, 10)
  assert.deepEqual(empty.emitted[0].payload, {})

  const offline = fakeSocket(undefined, false)
  assert.deepEqual(await emitSocialAck(offline, 'social:block', { targetUserId: 'ali' }), { ok: false, code: 'offline' })
  assert.equal(offline.emitted.length, 0, 'bağlantı yokken socket.io olayı sonradan göndermek üzere biriktirmemeli')
  const throwing: SocialAckSocket = { connected: true, emit() { throw new Error('kapandı') } }
  assert.deepEqual(await emitSocialAck(throwing, 'social:block', {}), { ok: false, code: 'offline' })

  assert.deepEqual(normalizeSocialAck(undefined), { ok: false, code: 'rejected' })
  assert.deepEqual(normalizeSocialAck({ ok: false, code: 'Kötü Kod' }), { ok: false, code: 'rejected' })
  assert.deepEqual(normalizeSocialAck({ ok: 'evet' }), { ok: false, code: 'rejected' })
})

test('emitSocialAck: 5 sn içinde yanıt yoksa zaman aşımı, geç gelen yanıt yok sayılır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let late: ((result: unknown) => void) | undefined
  const socket = fakeSocket((_event, _payload, callback) => { late = callback })
  const pending = emitSocialAck(socket, 'social:request-response', { requesterUserId: 'ali', action: 'accept' })
  let settled = false
  void pending.then(() => { settled = true })
  t.mock.timers.tick(SOCIAL_ACK_TIMEOUT_MS - 1)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.deepEqual(await pending, { ok: false, code: 'timeout' })
  assert.doesNotThrow(() => late?.({ ok: true }))
})

const outcomes = [
  ['başarı', (_event: string, _payload: unknown, callback: (result: unknown) => void) => callback({ ok: true })],
  ['hata', (_event: string, _payload: unknown, callback: (result: unknown) => void) => callback({ ok: false, code: 'rate_limited' })],
  ['zaman aşımı', undefined],
] as const

async function settle<T>(t: { mock: { timers: { tick: (ms: number) => void } } }, promise: Promise<T>) {
  t.mock.timers.tick(SOCIAL_ACK_TIMEOUT_MS)
  return promise
}

test('telefon: istek yanıtı başarıda gizli kalır, hata ve zaman aşımında kart geri gelir', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [name, answer] of outcomes) {
    const socket = fakeSocket(answer)
    const { ack, errors, view } = phone(socket)
    const pending = ack.actions.respondToMessageRequest('ali', 'reject')
    assert.deepEqual(view().messageRequests, [], name)
    const result = await settle(t, pending)
    assert.equal(result.ok, name === 'başarı', name)
    assert.deepEqual(socket.emitted[0], { event: 'social:request-response', payload: { requesterUserId: 'ali', action: 'reject' }, hasCallback: true })
    assert.equal(view().messageRequests.length, name === 'başarı' ? 0 : 1, name)
    assert.deepEqual(errors, name === 'başarı' ? [] : [socialErrorText(name === 'hata' ? 'rate_limited' : 'timeout')], name)
    // The next snapshot replaces an acknowledged change.
    ack.noteSnapshot()
    assert.equal(view().messageRequests.length, 1, name)
  }
})

test('telefon: mesaj tepkisi ve Tümünü okundu say hatada eski hâline döner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [name, answer] of outcomes) {
    const socket = fakeSocket(answer)
    const { ack, errors, view } = phone(socket)
    const reaction = ack.actions.reactToMessage('ali', 'm1', '👍')
    const read = ack.actions.markNotificationsRead()
    assert.deepEqual(view().conversations.ali[0].reactions, [{ actorId: 'me', reaction: '👍' }], name)
    assert.equal(view().notifications[0].read, true, name)
    const [reactionResult, readResult] = await settle(t, Promise.all([reaction, read]))
    const ok = name === 'başarı'
    assert.equal(reactionResult.ok, ok, name)
    assert.equal(readResult.ok, ok, name)
    assert.deepEqual(socket.emitted.map((item) => [item.event, item.payload]), [
      ['social:message-reaction', { targetUserId: 'ali', messageId: 'm1', reaction: '👍' }],
      ['social:notifications-read', {}],
    ])
    assert.deepEqual(view().conversations.ali[0].reactions, ok ? [{ actorId: 'me', reaction: '👍' }] : [], name)
    assert.equal(view().notifications[0].read, ok, name)
    assert.equal(errors.length, ok ? 0 : 2, name)
  }
})

test('telefon: engelleme sonucu döner; hata ve zaman aşımı Türkçe bildirilir; çevrimdışı olay gönderilmez', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [name, answer] of outcomes) {
    const socket = fakeSocket(answer)
    const { ack, errors } = phone(socket)
    const result = await settle(t, ack.actions.blockUser('ali'))
    assert.equal(result.ok, name === 'başarı', name)
    assert.deepEqual(socket.emitted.map((item) => item.event), ['social:block'])
    assert.deepEqual(errors, name === 'başarı' ? [] : [socialErrorText(name === 'hata' ? 'rate_limited' : 'timeout')], name)
  }
  const offline = fakeSocket(undefined, false)
  const { ack, errors, view } = phone(offline)
  assert.deepEqual(await ack.actions.blockUser('ali'), { ok: false, code: 'offline' })
  assert.deepEqual(errors, [socialErrorText('offline')])
  // Request and reaction buttons are disabled offline: no event, no notice.
  assert.deepEqual(await ack.actions.respondToMessageRequest('ali', 'accept'), { ok: false, code: 'offline' })
  assert.deepEqual(await ack.actions.markNotificationsRead(), { ok: false, code: 'offline' })
  assert.equal(view().messageRequests.length, 1)
  assert.equal(offline.emitted.length, 0)
  assert.equal(errors.length, 1)
})

test('telefon: oda üyeliği onayı katılma/ayrılma, ret ve zaman aşımı döndürür', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const joined = fakeSocket((_event, _payload, callback) => callback({ ok: true, status: 'left' }))
  assert.deepEqual(await emitSocialAck(joined, 'social:room-membership', { roomId: 'r1' }), { ok: true, status: 'left' })
  const full = fakeSocket((_event, _payload, callback) => callback({ ok: false, code: 'room_full' }))
  assert.deepEqual(await emitSocialAck(full, 'social:room-membership', { roomId: 'r1' }), { ok: false, code: 'room_full' })
  const silent = fakeSocket()
  assert.deepEqual(await settle(t, emitSocialAck(silent, 'social:room-membership', { roomId: 'r1' })), { ok: false, code: 'timeout' })
})

test('telefon: otomatik okundu bilgisi sessiz kalır; bildirim tercihi değişmediyse gönderilmez', async () => {
  const socket = fakeSocket((_event, _payload, callback) => callback({ ok: false, code: 'user_not_found' }))
  const { ack, errors } = phone(socket)
  assert.deepEqual(await ack.actions.markConversationRead('ali'), { ok: false, code: 'user_not_found' })
  assert.deepEqual(errors, [])
  assert.deepEqual(await ack.actions.updateNotificationPreferences({ messagesEnabled: true, reactionsEnabled: true }), { ok: true })
  assert.deepEqual(socket.emitted.map((item) => item.event), ['social:read'])
})

test('iyimser katman anlık görüntüyü değiştirmez ve boşken aynı nesneyi döndürür', () => {
  const state = baseState()
  assert.equal(applySocialPending(state, []), state)
  const view = applySocialPending(state, [
    { kind: 'request-response', userId: 'ali', token: 'a', confirmed: false },
    { kind: 'message-reaction', userId: 'ali', messageId: 'm1', reaction: '♥', token: 'b', confirmed: false },
    { kind: 'message-reaction', userId: 'ali', messageId: 'm1', reaction: '', token: 'c', confirmed: false },
    { kind: 'message-reaction', userId: 'ali', messageId: 'yok', reaction: '♥', token: 'd', confirmed: false },
    { kind: 'notifications-read', ids: ['n1'], token: 'e', confirmed: false },
    { kind: 'privacy', privacy: { profileVisibility: 'hidden', listeningVisibility: 'hidden' }, token: 'f', confirmed: false },
  ])
  assert.deepEqual(view.messageRequests, [])
  assert.deepEqual(view.conversations.ali[0].reactions, [], 'son değişiklik geçerli')
  assert.equal(view.notifications[0].read, true)
  assert.equal(view.privacy.profileVisibility, 'hidden')
  assert.equal(state.messageRequests.length, 1)
  assert.equal(state.notifications[0].read, false)
  assert.equal(state.privacy.profileVisibility, 'everyone')
})

test('aynı mesaja art arda iki tepki: eski onay yeni iyimser değişikliği silmez', async () => {
  const answers: Array<(result: unknown) => void> = []
  const socket = fakeSocket((_event, _payload, callback) => { answers.push(callback) })
  const { ack, view } = phone(socket)
  const first = ack.actions.reactToMessage('ali', 'm1', '♥')
  const second = ack.actions.reactToMessage('ali', 'm1', '🔥')
  assert.deepEqual(view().conversations.ali[0].reactions, [{ actorId: 'me', reaction: '🔥' }])
  answers[0]({ ok: false, code: 'rate_limited' })
  await first
  assert.deepEqual(view().conversations.ali[0].reactions, [{ actorId: 'me', reaction: '🔥' }])
  answers[1]({ ok: true })
  await second
  assert.deepEqual(view().conversations.ali[0].reactions, [{ actorId: 'me', reaction: '🔥' }])
})
