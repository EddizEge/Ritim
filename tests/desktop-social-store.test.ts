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

type ActionAnswer = DesktopSocialActionResult | Promise<DesktopSocialActionResult>

function setup(results: Record<string, DesktopSocialActionResult | ((payload?: Record<string, unknown>) => ActionAnswer)> = {}) {
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

test('mesaj gönderimi ack sonucunu balona döndürür, ayrı bildirim üretmez; tekrar aynı clientMessageId ile gider', async () => {
  let next: DesktopSocialActionResult = { ok: false, code: 'message_request_pending' }
  const { store, calls } = setup({ message: () => next })
  store.applyIncoming(incoming())

  assert.deepEqual(await store.actions.sendMessage('ali', '  cevap  '), { ok: false, code: 'message_request_pending' })
  assert.equal(calls[0].payload?.text, 'cevap')
  assert.match(String(calls[0].payload?.clientMessageId), /^id-/)
  assert.equal(store.getState().feedback, undefined)

  next = { ok: false, code: 'timeout' }
  assert.deepEqual(await store.actions.sendMessage('ali', 'cevap', 'client-1'), { ok: false, code: 'timeout' })
  assert.equal(calls[1].payload?.clientMessageId, 'client-1')

  // The retry reuses the id; the gateway reports the duplicate as delivered.
  next = { ok: true, duplicate: true }
  assert.deepEqual(await store.actions.sendMessage('ali', 'cevap', 'client-1'), { ok: true, duplicate: true })
  assert.equal(calls[2].payload?.clientMessageId, 'client-1')
  assert.equal(store.getState().feedback, undefined)

  next = { ok: false }
  assert.deepEqual(await store.actions.sendMessage('ali', 'cevap'), { ok: false, code: 'rejected' })
  assert.deepEqual(await store.actions.sendMessage('ali', '   '), { ok: false, code: 'invalid_payload' })
  assert.equal(calls.length, 4)
  next = { ok: true, duplicate: false }
  assert.deepEqual(await store.actions.sendMessage('ali', 'x'.repeat(600)), { ok: true, duplicate: false })
  assert.equal(String(calls[4].payload?.text).length, 500)
})

test('bağlantı yokken mesaj gönderilmez ve oda mesajı sessizce taslakta kalır', async () => {
  const { store, calls } = setup()
  store.applyIncoming(incoming({ connectionStatus: 'offline' }))
  assert.deepEqual(await store.actions.sendMessage('ali', 'selam'), { ok: false, code: 'offline' })
  assert.equal(store.getState().feedback, undefined)
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
  // Every user action reports its error through the acknowledgement; the
  // gateway's extra social:error for it must not show a second notice.
  for (const event of ['listening', 'create-room', 'request-response', 'message-reaction', 'notifications-read', 'block', 'mute', 'report', 'privacy', 'reaction', 'read']) {
    store.handleEvent({ kind: 'error', code: 'rate_limited', event })
    assert.equal(store.getState().feedback, undefined, event)
  }
  store.handleEvent({ kind: 'error', code: 'room_owner_offline', event: '' })
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

test('son başarılı bağlantı zamanı tutulur, ana sürecin değeri önceliklidir; Sosyal ayarları ana süreçte açılır', async () => {
  const { store, calls, advance } = setup({ 'open-settings': { ok: true } })
  store.applyIncoming(incoming({ connectionStatus: 'connecting' }))
  assert.equal(store.getState().lastOnlineAt, undefined)
  store.applyIncoming(incoming())
  assert.equal(store.getState().lastOnlineAt, 1_000)
  advance(60_000)
  store.applyIncoming(incoming({ connectionStatus: 'offline' }))
  assert.equal(store.getState().lastOnlineAt, 61_000)
  advance(60_000)
  store.applyIncoming(incoming({ connectionStatus: 'connecting' }))
  assert.equal(store.getState().lastOnlineAt, 61_000)
  store.applyIncoming(incoming({ connectionStatus: 'offline', lastOnlineAt: 5_000 }))
  assert.equal(store.getState().lastOnlineAt, 5_000)
  store.actions.openSettings('notifications')
  await flush()
  assert.deepEqual(calls.at(-1), { type: 'open-settings', payload: { section: 'notifications' } })
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

function deferred() {
  let resolve: (value: DesktopSocialActionResult) => void = () => {}
  const promise = new Promise<DesktopSocialActionResult>((done) => { resolve = done })
  return { promise, resolve }
}

const request = { userId: 'ali', direction: 'incoming' as const, preview: 'selam', sentAt: 1 }

test('istek yanıtı: kart hemen kalkar; başarıda depo bildirim üretmez, hata ve zaman aşımında kart geri gelir', async () => {
  for (const [answer, text] of [
    [{ ok: true }, undefined],
    [{ ok: false, code: 'request_not_found' }, socialErrorText('request_not_found')],
    [{ ok: false, code: 'timeout' }, socialErrorText('timeout')],
  ] as const) {
    const gate = deferred()
    const { store, calls } = setup({ 'request-response': () => gate.promise })
    store.applyIncoming(incoming({ messageRequests: [request] }))
    const pending = store.actions.respondToMessageRequest('ali', 'reject')
    assert.deepEqual(store.getState().messageRequests, [], 'iyimser olarak gizlenir')
    assert.equal(store.getState(), store.getState(), 'aynı durum nesnesi döner')
    gate.resolve(answer)
    const result = await pending
    assert.equal(result.ok, answer.ok)
    assert.deepEqual(calls, [{ type: 'request-response', payload: { requesterUserId: 'ali', action: 'reject' } }])
    assert.equal(store.getState().feedback?.text, text)
    assert.deepEqual(store.getState().messageRequests, answer.ok ? [] : [request])
    if (answer.ok) {
      // The gateway sent its new state before the acknowledgement; from the
      // next snapshot on, only the gateway decides.
      store.applyIncoming(incoming({ messageRequests: [request] }))
      assert.deepEqual(store.getState().messageRequests, [request])
    }
  }
})

test('istek yanıtı çevrimdışıyken gönderilmez ve kartı gizlemez', async () => {
  const { store, calls } = setup()
  store.applyIncoming(incoming({ connectionStatus: 'offline', messageRequests: [request] }))
  assert.deepEqual(await store.actions.respondToMessageRequest('ali', 'accept'), { ok: false, code: 'offline' })
  assert.deepEqual(store.getState().messageRequests, [request])
  assert.deepEqual(calls, [])
  assert.equal(store.getState().feedback, undefined)
})

test('mesaj tepkisi hemen görünür; hata ve zaman aşımında eski hâline döner', async () => {
  const message = { id: 'm1', senderId: 'ali', text: 'selam', sentAt: 1, reactions: [{ actorId: 'ali', reaction: '♥' as const }] }
  for (const [answer, text] of [
    [{ ok: true }, undefined],
    [{ ok: false, code: 'reaction_blocked' }, socialErrorText('reaction_blocked')],
    [{ ok: false, code: 'timeout' }, socialErrorText('timeout')],
  ] as const) {
    const gate = deferred()
    const { store } = setup({ 'message-reaction': () => gate.promise })
    store.applyIncoming(incoming({ conversations: { ali: [message] } }))
    const pending = store.actions.reactToMessage('ali', 'm1', '🔥')
    assert.deepEqual(store.getState().conversations.ali[0].reactions, [{ actorId: 'ali', reaction: '♥' }, { actorId: 'me', reaction: '🔥' }])
    gate.resolve(answer)
    assert.equal((await pending).ok, answer.ok)
    assert.equal(store.getState().feedback?.text, text)
    assert.deepEqual(
      store.getState().conversations.ali[0].reactions,
      answer.ok ? [{ actorId: 'ali', reaction: '♥' }, { actorId: 'me', reaction: '🔥' }] : message.reactions,
    )
  }

  // The same emoji again removes it (gateway toggle); a refusal puts it back.
  const own = { ...message, reactions: [{ actorId: 'me', reaction: '🔥' as const }] }
  const gate = deferred()
  const { store } = setup({ 'message-reaction': () => gate.promise })
  store.applyIncoming(incoming({ conversations: { ali: [own] } }))
  const pending = store.actions.reactToMessage('ali', 'm1', '🔥')
  assert.deepEqual(store.getState().conversations.ali[0].reactions, [])
  gate.resolve({ ok: false, code: 'rate_limited' })
  await pending
  assert.deepEqual(store.getState().conversations.ali[0].reactions, own.reactions)
  assert.equal(store.getState().feedback?.text, socialErrorText('rate_limited'))
})

test('Tümünü okundu say noktaları hemen söndürür; hata ve zaman aşımında geri gelir', async () => {
  const notifications = [
    { id: 'n1', kind: 'message' as const, actorId: 'ali', body: 'selam', createdAt: 1, read: false },
    { id: 'n2', kind: 'profile_reaction' as const, actorId: 'ayse', body: '♥', createdAt: 2, read: true },
  ]
  for (const [answer, text] of [
    [{ ok: true }, undefined],
    [{ ok: false, code: 'server_error' }, socialErrorText('server_error')],
    [{ ok: false, code: 'timeout' }, socialErrorText('timeout')],
  ] as const) {
    const gate = deferred()
    const { store, calls } = setup({ 'notifications-read': () => gate.promise })
    store.applyIncoming(incoming({ notifications }))
    const pending = store.actions.markNotificationsRead()
    assert.deepEqual(store.getState().notifications.map((item) => item.read), [true, true])
    // A notification that arrives meanwhile is not part of "all".
    const late = { id: 'n3', kind: 'message' as const, actorId: 'ali', body: 'yeni', createdAt: 3, read: false }
    store.applyIncoming(incoming({ notifications: [...notifications, late] }))
    assert.deepEqual(store.getState().notifications.map((item) => item.read), [true, true, false])
    gate.resolve(answer)
    assert.equal((await pending).ok, answer.ok)
    assert.deepEqual(calls.map((call) => call.type), ['notifications-read'])
    assert.equal(store.getState().feedback?.text, text)
    assert.deepEqual(store.getState().notifications.map((item) => item.read), answer.ok ? [true, true, false] : [false, true, false])
  }
})

test('engelleme: sonuç arayüze döner; hata ve zaman aşımında Türkçe hata bildirimi çıkar', async () => {
  for (const [answer, text] of [
    [{ ok: true }, undefined],
    [{ ok: false, code: 'user_not_found' }, socialErrorText('user_not_found')],
    [{ ok: false, code: 'timeout' }, socialErrorText('timeout')],
    [{ ok: false, code: 'offline' }, socialErrorText('offline')],
  ] as const) {
    const { store, calls } = setup({ block: answer })
    store.applyIncoming(incoming())
    assert.deepEqual(await store.actions.blockUser('ali'), answer.ok ? { ok: true } : { ok: false, code: answer.code })
    assert.deepEqual(calls, [{ type: 'block', payload: { targetUserId: 'ali' } }])
    assert.equal(store.getState().feedback?.text, text)
  }
  for (const code of ['invalid_request', 'user_not_found', 'request_not_found', 'reaction_blocked', 'conversation_not_found', 'server_error', 'timeout', 'offline']) {
    assert.notEqual(socialErrorText(code), socialErrorText('bilinmeyen'), code)
  }
})

test('oda üyeliği: katılma başarısı, ret ve zaman aşımı bildirilir', async () => {
  for (const [answer, text] of [
    [{ ok: true, status: 'joined' }, SOCIAL_TEXT.roomJoined],
    [{ ok: false, code: 'room_access_denied' }, socialErrorText('room_access_denied')],
    [{ ok: false, code: 'timeout' }, socialErrorText('timeout')],
  ] as const) {
    const { store } = setup({ 'room-membership': answer })
    store.applyIncoming(incoming({ rooms: [room('room-1', 'ali')] }))
    store.actions.joinRoom('room-1')
    await flush()
    assert.equal(store.getState().feedback?.text, text)
    assert.equal(store.getState().feedback?.tone, answer.ok ? 'success' : 'error')
  }
})

test('gizlilik ve bildirim tercihleri iyimser; reddedilince eski değere döner', async () => {
  const { store } = setup({
    privacy: { ok: false, code: 'rate_limited' },
    'notification-preferences': { ok: false, code: 'timeout' },
  })
  store.applyIncoming(incoming())
  const privacy = store.actions.updatePrivacy({ profileVisibility: 'hidden', listeningVisibility: 'contacts' })
  assert.equal(store.getState().privacy.profileVisibility, 'hidden')
  await privacy
  assert.equal(store.getState().privacy.profileVisibility, 'everyone')
  assert.equal(store.getState().feedback?.text, socialErrorText('rate_limited'))
  const preferences = store.actions.updateNotificationPreferences({ messagesEnabled: false, reactionsEnabled: true, deviceEnabled: false })
  assert.equal(store.getState().notificationPreferences.messagesEnabled, false)
  await preferences
  assert.equal(store.getState().notificationPreferences.messagesEnabled, true)
  assert.equal(store.getState().feedback?.text, socialErrorText('timeout'))
})

test('profil kalbi, sessize alma, şikâyet ve oda hataları bildirilir; otomatik okundu bilgisi sessiz kalır', async () => {
  const { store } = setup({
    reaction: { ok: false, code: 'reaction_blocked' },
    mute: { ok: false, code: 'conversation_not_found' },
    report: { ok: true },
    'create-room': { ok: false, code: 'room_owner_offline' },
    listening: { ok: false, code: 'room_full' },
    read: { ok: false, code: 'user_not_found' },
  })
  store.applyIncoming(incoming({ unreadCounts: { ali: 1 } }))
  assert.deepEqual(await store.actions.reactToUser('ali'), { ok: false, code: 'reaction_blocked' })
  assert.equal(store.getState().feedback?.text, socialErrorText('reaction_blocked'))
  assert.deepEqual(await store.actions.toggleMute('ali'), { ok: false, code: 'conversation_not_found' })
  assert.equal(store.getState().feedback?.text, socialErrorText('conversation_not_found'))
  store.actions.clearFeedback()
  assert.deepEqual(await store.actions.reportUser('ali', 'Spam'), { ok: true })
  assert.equal(store.getState().feedback, undefined)
  assert.deepEqual(await store.actions.createRoom(), { ok: false, code: 'room_owner_offline' })
  assert.equal(store.getState().feedback?.text, socialErrorText('room_owner_offline'))
  assert.deepEqual(await store.actions.toggleListeningWith('ali'), { ok: false, code: 'room_full' })
  assert.equal(store.getState().feedback?.text, socialErrorText('room_full'))
  store.actions.clearFeedback()
  store.actions.markConversationRead('ali')
  await flush()
  assert.equal(store.getState().feedback, undefined)
})

test('başka hesaba geçilince bekleyen iyimser değişiklikler gösterilmez', async () => {
  const gate = deferred()
  const { store } = setup({ 'request-response': () => gate.promise })
  store.applyIncoming(incoming({ messageRequests: [request] }))
  const pending = store.actions.respondToMessageRequest('ali', 'accept')
  assert.deepEqual(store.getState().messageRequests, [])
  store.applyIncoming(incoming({ currentUser: user('baska'), messageRequests: [request] }))
  assert.deepEqual(store.getState().messageRequests, [request])
  gate.resolve({ ok: true })
  await pending
  assert.deepEqual(store.getState().messageRequests, [request])
})
