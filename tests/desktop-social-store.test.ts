import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDesktopSocialStore,
  type DesktopSocialActionResult,
  type DesktopSocialEvent,
  type DesktopSocialIncomingState,
  type RitimSocialBridge,
} from '../src/desktopSocial/desktopSocialStore'
import { SOCIAL_TEXT, socialErrorText } from '../src/social/socialShared'
import type { SocialRoom, SocialUser } from '../src/social/types'

type Call = { type: string; payload?: Record<string, unknown> }

function user(id: string): SocialUser {
  return { id, displayName: id.toUpperCase(), handle: `@${id}`, initials: id[0].toUpperCase(), avatarTone: 1, presence: 'online', reactionCount: 0 }
}

function room(id: string, ownerId: string, viewerRole?: SocialRoom['viewerRole']): SocialRoom {
  return {
    id,
    ownerId,
    title: 'Oda',
    memberCount: 2,
    maxMembers: 8,
    cover: 0,
    isLive: true,
    ownerDesktopOnline: true,
    lifecycle: 'live',
    viewerPlaybackStatus: 'ready',
    memberInitials: ['A'],
    viewerRole,
  }
}

function incoming(patch: DesktopSocialIncomingState = {}): DesktopSocialIncomingState {
  return {
    connectionStatus: 'online',
    currentUser: user('me'),
    users: [user('ali'), user('ayse')],
    rooms: [],
    conversations: {},
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    selectedUserId: '',
    ...patch,
  }
}

function setup(results: Record<string, DesktopSocialActionResult | ((payload?: Record<string, unknown>) => DesktopSocialActionResult)> = {}) {
  const calls: Call[] = []
  let clock = 1_000
  let ids = 0
  const stateListeners = new Set<(state: DesktopSocialIncomingState) => void>()
  const eventListeners = new Set<(event: DesktopSocialEvent) => void>()
  const visibilityListeners = new Set<(visible: boolean) => void>()
  const bridge: RitimSocialBridge = {
    getState: async () => incoming(),
    action: async (type, payload) => {
      calls.push({ type, payload })
      const result = results[type]
      if (typeof result === 'function') return result(payload)
      return result || { ok: true, acknowledged: false }
    },
    getAppearance: async () => ({}),
    onState: (callback) => { stateListeners.add(callback); return () => stateListeners.delete(callback) },
    onEvent: (callback) => { eventListeners.add(callback); return () => eventListeners.delete(callback) },
    onVisibility: (callback) => { visibilityListeners.add(callback); return () => visibilityListeners.delete(callback) },
    onAppearance: () => () => {},
  }
  const store = createDesktopSocialStore(bridge, { now: () => clock, newId: () => `id-${++ids}` })
  return {
    store,
    calls,
    advance: (ms: number) => { clock += ms },
    pushState: (state: DesktopSocialIncomingState) => { for (const listener of stateListeners) listener(state) },
    pushEvent: (event: DesktopSocialEvent) => { for (const listener of eventListeners) listener(event) },
    pushVisibility: (visible: boolean) => { for (const listener of visibilityListeners) listener(visible) },
    listenerCount: () => stateListeners.size + eventListeners.size + visibilityListeners.size,
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('mesaj taslağı yalnız ack ok ise temizlenir; ret, zaman aşımı ve çevrimdışı ayrı bildirilir', async () => {
  let next: DesktopSocialActionResult = { ok: false, code: 'message_request_pending' }
  const { store, calls } = setup({ message: () => next })
  store.applyIncoming(incoming())

  assert.equal(await store.actions.sendMessage('ali', '  cevap  '), false)
  assert.equal(store.getState().feedback?.text, socialErrorText('message_request_pending'))
  assert.equal(store.getState().feedback?.tone, 'error')
  assert.equal(calls[0].payload?.text, 'cevap')
  assert.match(String(calls[0].payload?.clientMessageId), /^id-/)

  next = { ok: false, code: 'timeout' }
  assert.equal(await store.actions.sendMessage('ali', 'cevap'), false)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.messageTimeout)

  next = { ok: false, code: 'offline' }
  assert.equal(await store.actions.sendMessage('ali', 'cevap'), false)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.messageOffline)

  next = { ok: true, duplicate: false }
  assert.equal(await store.actions.sendMessage('ali', 'cevap'), true)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.messageDelivered)
  assert.equal(store.getState().feedback?.tone, 'success')

  assert.equal(await store.actions.sendMessage('ali', '   '), false)
  assert.equal(calls.length, 4)
  assert.equal(await store.actions.sendMessage('ali', 'x'.repeat(600)), true)
  assert.equal(String(calls[4].payload?.text).length, 500)
})

test('bağlantı yokken mesaj gönderilmez ve oda mesajı sessizce taslakta kalır', async () => {
  const { store, calls } = setup()
  store.applyIncoming(incoming({ connectionStatus: 'offline' }))
  assert.equal(await store.actions.sendMessage('ali', 'selam'), false)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.messageOffline)
  assert.equal(await store.actions.sendRoomMessage('room-1', 'selam'), false)
  store.actions.markConversationRead('ali')
  store.actions.respondToMessageRequest('ali', 'accept')
  assert.deepEqual(calls, [])
})

test('istek kabul/ret, tepki, bildirim okundu ve sessize alma doğru eyleme gider', async () => {
  const { store, calls } = setup()
  store.applyIncoming(incoming())
  store.actions.respondToMessageRequest('ali', 'accept')
  store.actions.respondToMessageRequest('ayse', 'reject')
  store.actions.reactToMessage('ali', 'm-1', '🔥')
  store.actions.markNotificationsRead()
  store.actions.toggleMute('ali')
  store.actions.reportUser('ali', '  Spam ', ' ayrıntı ', undefined)
  store.actions.reactToUser('ayse')
  await flush()
  assert.deepEqual(calls, [
    { type: 'request-response', payload: { requesterUserId: 'ali', action: 'accept' } },
    { type: 'request-response', payload: { requesterUserId: 'ayse', action: 'reject' } },
    { type: 'message-reaction', payload: { targetUserId: 'ali', messageId: 'm-1', reaction: '🔥' } },
    { type: 'notifications-read', payload: undefined },
    { type: 'mute', payload: { targetUserId: 'ali' } },
    { type: 'report', payload: { targetUserId: 'ali', reason: 'Spam', detail: 'ayrıntı', messageId: '' } },
    { type: 'reaction', payload: { targetUserId: 'ayse', reaction: '♥' } },
  ])
})

test('gizli görünümde okundu bilgisi bekletilir, görünür olunca gönderilir', async () => {
  const { store, calls, pushVisibility } = setup()
  store.applyIncoming(incoming({ unreadCounts: { ali: 2 }, viewVisible: false }))
  store.actions.markConversationRead('ali')
  await flush()
  assert.deepEqual(calls, [])
  pushVisibility(true)
  const stop = store.start()
  pushVisibility(true)
  await flush()
  stop()
  assert.deepEqual(calls, [{ type: 'read', payload: { targetUserId: 'ali' } }])
  store.actions.markConversationRead('ali')
  await flush()
  assert.equal(calls.length, 2)
})

test('odadan bilerek ayrılmak veya odayı kapatmak "oda kapatıldı" uyarısı üretmez', async () => {
  const { store, calls } = setup({ 'room-membership': { ok: true, status: 'left' } })
  store.applyIncoming(incoming({ rooms: [room('room-1', 'ali', 'listener')], activeRoomId: 'room-1', listeningWithUserId: 'ali' }))
  store.actions.joinRoom('room-1')
  await flush()
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomLeft)
  store.applyIncoming(incoming({ rooms: [room('room-1', 'ali')] }))
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomLeft)

  store.applyIncoming(incoming({ rooms: [room('own', 'me', 'owner')], activeRoomId: 'own' }))
  store.actions.createRoom()
  store.applyIncoming(incoming({ rooms: [] }))
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomLeft)
  assert.deepEqual(calls.map((call) => call.type), ['room-membership', 'create-room'])
  assert.deepEqual(calls[1].payload, undefined)

  store.applyIncoming(incoming({ rooms: [room('room-2', 'ayse', 'listener')], activeRoomId: 'room-2' }))
  store.applyIncoming(incoming({ rooms: [] }))
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomClosed)
})

test('beklenmedik ayrılış süre dolunca bildirilir; çıkış/çevrimdışı yer tutucu durum bildirilmez', () => {
  const { store, advance } = setup()
  store.applyIncoming(incoming({ rooms: [room('room-1', 'ali', 'listener')], activeRoomId: 'room-1', listeningWithUserId: 'ali' }))
  store.actions.toggleListeningWith('ali')
  advance(6_000)
  store.applyIncoming(incoming())
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomClosed)

  store.actions.clearFeedback()
  store.applyIncoming(incoming({ rooms: [room('room-1', 'ali', 'listener')], activeRoomId: 'room-1' }))
  store.applyIncoming({ connectionStatus: 'connecting' })
  assert.equal(store.getState().feedback, undefined)
  assert.equal(store.getState().activeRoomId, undefined)
})

test('oda üyeliği reddi ve oda tepkisi hatası kullanıcıya gösterilir', async () => {
  const { store } = setup({
    'room-membership': { ok: false, code: 'room_full' },
    'room-reaction': { ok: false, code: 'room_access_denied' },
    'room-message': { ok: false, code: 'timeout' },
  })
  store.applyIncoming(incoming({ rooms: [room('room-1', 'ali')] }))
  store.actions.joinRoom('room-1')
  await flush()
  assert.equal(store.getState().feedback?.text, socialErrorText('room_full'))
  store.actions.sendRoomReaction('room-1', '🎵')
  await flush()
  assert.equal(store.getState().feedback?.text, socialErrorText('room_access_denied'))
  assert.equal(await store.actions.sendRoomMessage('room-1', 'merhaba'), false)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.roomMessageTimeout)
})

test('sunucu hata olayları useSocial ile aynı süzülür; şikâyet kaydı bildirilir', () => {
  const { store } = setup()
  store.applyIncoming(incoming())
  for (const event of ['message', 'room-message', 'room-reaction', 'room-membership', 'profile', 'room-playback', 'join']) {
    store.handleEvent({ kind: 'error', code: 'rate_limited', event })
    assert.equal(store.getState().feedback, undefined, event)
  }
  store.handleEvent({ kind: 'error', code: 'room_owner_offline', event: 'listening' })
  assert.equal(store.getState().feedback?.text, socialErrorText('room_owner_offline'))
  store.handleEvent({ kind: 'report-saved' })
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.reportSaved)
})

test('seçili sohbet korunur, bağlantı kopunca bir kez bilgi verilir', () => {
  const { store } = setup()
  store.applyIncoming(incoming())
  store.actions.selectUser('ayse')
  store.applyIncoming(incoming({ selectedUserId: '' }))
  assert.equal(store.getState().selectedUserId, 'ayse')
  store.applyIncoming(incoming({ connectionStatus: 'offline' }))
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.disconnected)
  store.actions.clearFeedback()
  store.applyIncoming(incoming({ connectionStatus: 'connecting' }))
  store.applyIncoming(incoming({ connectionStatus: 'offline' }))
  assert.equal(store.getState().feedback, undefined)
  store.applyIncoming(incoming({ users: [user('ali')] }))
  assert.equal(store.getState().selectedUserId, '')
})

test('PC sistem bildirimi anahtarı ana süreçten açılıp kapanır', async () => {
  const { store, calls } = setup({
    'device-notifications': (payload) => ({ ok: true, enabled: payload?.enabled === true, supported: true }),
  })
  store.applyIncoming(incoming())
  store.actions.requestDeviceNotifications()
  await flush()
  assert.equal(store.getState().notificationPreferences.deviceEnabled, true)
  assert.equal(store.getState().feedback?.text, SOCIAL_TEXT.deviceNotificationsOn)
  store.actions.requestDeviceNotifications()
  await flush()
  assert.equal(store.getState().notificationPreferences.deviceEnabled, false)
  store.actions.updateNotificationPreferences({ messagesEnabled: false, reactionsEnabled: true, deviceEnabled: false })
  await flush()
  assert.deepEqual(calls.map((call) => [call.type, call.payload]), [
    ['device-notifications', { enabled: true }],
    ['device-notifications', { enabled: false }],
    ['notification-preferences', { messagesEnabled: false, reactionsEnabled: true }],
  ])
  store.applyIncoming(incoming({ notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: true } }))
  assert.equal(store.getState().notificationPreferences.deviceEnabled, true)
})

test('Google giriş/çıkış ve yeniden bağlan ana süreç akışına gider; kimlik özeti gösterilir', async () => {
  const { store, calls } = setup({ 'sign-in': { ok: false, code: 'sign_in_failed' } })
  store.applyIncoming(incoming({
    connectionStatus: 'offline',
    authentication: { configured: true, required: true, authenticated: false },
  }))
  assert.equal(store.getState().authentication?.required, true)
  store.actions.signIn()
  await flush()
  store.actions.signOut()
  store.actions.reconnectSocial()
  assert.equal(store.getState().connectionStatus, 'connecting')
  await flush()
  assert.deepEqual(calls.map((call) => call.type), ['sign-in', 'sign-out', 'reconnect'])
})

test('start dinleyicileri bir kez kurar ve temizler; ilk durumu IPC ile alır', async () => {
  const { store, listenerCount } = setup()
  const stopFirst = store.start()
  stopFirst()
  const stop = store.start()
  assert.equal(listenerCount(), 3)
  await flush()
  assert.equal(store.getState().connectionStatus, 'online')
  assert.equal(store.getState().users.length, 2)
  stop()
  assert.equal(listenerCount(), 0)
})
