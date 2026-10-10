import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountActivity,
  accusative,
  canJoinRoom,
  connectionLine,
  conversationSummaries,
  dative,
  deviceNotificationContent,
  groupListeners,
  groupNotifications,
  idleActivityLine,
  incomingRequests,
  messagesBadgeCount,
  notificationView,
  notificationViews,
  possessive,
  presenceLabel,
  relativeTimeLabel,
  roomStatus,
  roomStripFor,
  roomSyncLabel,
  sendFailureReason,
  unreadNotificationCount,
} from '../src/social/socialModel'
import type { SocialNotification, SocialRoom, SocialState, SocialTrack, SocialUser } from '../src/social/types'

function track(title: string, isPlaying = true): SocialTrack {
  return { id: `t-${title}`, videoId: `v-${title}`, title, artist: 'Sanatçı', duration: 200, position: 10, cover: 1, isPlaying }
}

function user(id: string, presence: SocialUser['presence'] = 'online', currentTrack?: SocialTrack): SocialUser {
  return { id, displayName: id.toUpperCase(), handle: `@${id}`, initials: id.slice(0, 2).toUpperCase(), avatarTone: 1, presence, currentTrack, reactionCount: 0 }
}

function room(id: string, ownerId: string, patch: Partial<SocialRoom> = {}): SocialRoom {
  return {
    id, ownerId, title: id, memberCount: 2, maxMembers: 8, cover: 0, isLive: true, ownerDesktopOnline: true,
    lifecycle: 'live', viewerPlaybackStatus: 'idle', memberInitials: ['A'], ...patch,
  }
}

function state(patch: Partial<SocialState> = {}): SocialState {
  return {
    connectionStatus: 'online',
    currentUser: user('me', 'online', track('Gesi Bağları')),
    privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' },
    currentDeviceCount: 1,
    companionConnected: false,
    users: [],
    rooms: [],
    roomMessages: {},
    roomReactions: {},
    conversations: {},
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    mutedUserIds: [],
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
    selectedUserId: '',
    ...patch,
  }
}

test('varlık etiketi gerçek durumu söyler; sohbet başlığı artık hep "Çevrimiçi" değildir', () => {
  assert.deepEqual(presenceLabel('online'), { text: 'Çevrimiçi', tone: 'online' })
  assert.deepEqual(presenceLabel('away'), { text: 'Uzakta', tone: 'away' })
  assert.deepEqual(presenceLabel('offline'), { text: 'Çevrimdışı', tone: 'offline' })
  assert.deepEqual(presenceLabel(undefined), { text: 'Çevrimdışı', tone: 'offline' })
})

test('dinleyenler: çalan, duraklatan/boşta ve çevrimdışı ayrı; arama ad, kullanıcı adı, parça ve sanatçıda', () => {
  const users = [
    user('ali', 'online', track('Dönence')),
    user('ayse', 'online', track('Islak Islak', false)),
    user('can', 'away'),
    user('deniz', 'offline', track('Eski')),
  ]
  const groups = groupListeners(users)
  assert.deepEqual(groups.listening.map((item) => item.id), ['ali'])
  assert.deepEqual(groups.online.map((item) => item.id), ['ayse', 'can'])
  assert.deepEqual(groups.offline.map((item) => item.id), ['deniz'])
  assert.deepEqual(groupListeners(users, 'DÖNENCE').listening.map((item) => item.id), ['ali'])
  assert.deepEqual(groupListeners(users, '@can').online.map((item) => item.id), ['can'])
  assert.equal(groupListeners(users, 'sanatçı').listening.length + groupListeners(users, 'sanatçı').online.length, 2)
  assert.equal(idleActivityLine(users[1]), 'Duraklattı · Islak Islak')
  assert.equal(idleActivityLine(users[2]), 'Uzakta · bir şey dinlemiyor')
  assert.equal(idleActivityLine(user('eda')), 'Çevrimiçi · bir şey dinlemiyor')
})

test('Mesajlar rozeti 1. aşama kuralı: okunmamışlar + gelen istekler; zil rozeti yalnız bilinen okunmamış bildirimler', () => {
  const current = state({
    unreadCounts: { a: 2, b: 0, c: -1 },
    messageRequests: [
      { userId: 'x', direction: 'incoming', preview: 'selam', sentAt: 1 },
      { userId: 'y', direction: 'outgoing', preview: 'merhaba', sentAt: 2 },
    ],
    notifications: [
      { id: 'n1', kind: 'message', actorId: 'a', body: 'x', createdAt: 1, read: false },
      { id: 'n2', kind: 'profile_reaction', actorId: 'a', body: '🔥', createdAt: 2, read: false },
      { id: 'n3', kind: 'reaction', actorId: 'a', body: '♥', createdAt: 3, read: true },
      { id: 'n4', kind: 'mystery' as SocialNotification['kind'], actorId: 'a', body: '?', createdAt: 4, read: false },
    ],
  })
  assert.equal(messagesBadgeCount(current), 3)
  assert.equal(unreadNotificationCount(current), 2)
})

test('sohbet listesi: kendi son mesajında "Sen:", giden istek bekliyor, gelen istek ve engelli ayrı tutulur', () => {
  const current = state({
    users: [user('ali'), user('ayse'), user('bora', 'offline'), user('cem')],
    blockedUsers: [user('cem')],
    conversations: {
      ali: [{ id: 'm1', senderId: 'ali', text: 'Selam', sentAt: 100, reactions: [] }, { id: 'm2', senderId: 'me', text: 'Merhaba', sentAt: 300, reactions: [] }],
      ayse: [{ id: 'm3', senderId: 'ayse', text: 'Nasılsın?', sentAt: 200, reactions: [] }],
      cem: [{ id: 'm4', senderId: 'cem', text: 'x', sentAt: 400, reactions: [] }],
      zeynep: [{ id: 'm5', senderId: 'zeynep', text: 'İstek', sentAt: 500, reactions: [] }],
    },
    unreadCounts: { ayse: 1 },
    mutedUserIds: ['ayse'],
    messageRequests: [
      { userId: 'bora', direction: 'outgoing', preview: 'Merhaba Bora', sentAt: 50 },
      { userId: 'zeynep', direction: 'incoming', preview: 'İstek', sentAt: 500 },
    ],
  })
  const summaries = conversationSummaries(current)
  assert.deepEqual(summaries.map((item) => item.userId), ['ali', 'ayse', 'bora'])
  assert.equal(summaries[0].preview, 'Sen: Merhaba')
  assert.equal(summaries[1].preview, 'Nasılsın?')
  assert.equal(summaries[1].unread, 1)
  assert.equal(summaries[1].muted, true)
  assert.equal(summaries[2].outgoingPending, true)
  assert.equal(summaries[2].preview, 'Sen: Merhaba Bora')
  const requests = incomingRequests(current)
  assert.deepEqual(requests.map((item) => item.userId), ['zeynep'])
  assert.equal(requests[0].user.displayName, 'Ritim kullanıcısı')
})

test('bildirim türü eşlemesi: profile_reaction "profiline … bıraktı", tepki alıntısı, istek hedefi; bilinmeyen tür atlanır', () => {
  const current = state({
    users: [user('elif'), user('mert'), user('selin')],
    conversations: { selin: [{ id: 's1', senderId: 'me', text: 'Yarın odayı açalım mı?', sentAt: 10, reactions: [] }] },
    messageRequests: [{ userId: 'mert', direction: 'incoming', preview: 'Selam!', sentAt: 5 }],
    notifications: [
      { id: 'p', kind: 'profile_reaction', actorId: 'elif', body: '🔥', createdAt: 40, read: false },
      { id: 'r', kind: 'reaction', actorId: 'selin', messageId: 's1', body: '♥', createdAt: 30, read: true },
      { id: 'q', kind: 'message_request', actorId: 'mert', body: 'Selam!', createdAt: 20, read: false },
      { id: 'm', kind: 'message', actorId: 'selin', body: 'Bak', createdAt: 10, read: true },
      { id: 'x', kind: 'future_kind' as SocialNotification['kind'], actorId: 'elif', body: '?', createdAt: 50, read: false },
    ],
  })
  const views = notificationViews(current)
  assert.deepEqual(views.map((view) => view.id), ['p', 'r', 'q', 'm'])
  const profile = views[0]
  assert.equal(`${profile.actor.displayName} ${profile.action}`, 'ELIF profiline 🔥 bıraktı')
  assert.deepEqual(profile.badge, { kind: 'emoji', emoji: '🔥' })
  assert.deepEqual(profile.target, { kind: 'profile', userId: 'elif' })
  assert.equal(profile.quote, undefined)
  assert.equal(views[1].action, 'mesajına ♥ verdi')
  assert.equal(views[1].quote, 'Yarın odayı açalım mı?')
  assert.deepEqual(views[2].target, { kind: 'request', userId: 'mert' })
  assert.deepEqual(views[3].target, { kind: 'chat', userId: 'selin' })
  assert.equal(notificationView({ id: 'z', kind: 'nope' as SocialNotification['kind'], body: '', createdAt: 1, read: false }, current), null)
  // Accepted request: the notification now opens the chat.
  assert.deepEqual(notificationView(current.notifications[2], { ...current, messageRequests: [] })?.target, { kind: 'chat', userId: 'mert' })
  // "Yeni" keeps what was unread when the screen opened.
  const grouped = groupNotifications(views.map((view) => ({ ...view, read: true })), new Set(['p', 'q']))
  assert.deepEqual(grouped.fresh.map((view) => view.id), ['p', 'q'])
  assert.deepEqual(grouped.earlier.map((view) => view.id), ['r', 'm'])
})

test('sistem bildirimi metni türe göre; tepki kapalıysa profile_reaction da gösterilmez', () => {
  const base = { id: 'n', actorId: 'a', createdAt: 1, read: false }
  assert.deepEqual(deviceNotificationContent({ ...base, kind: 'profile_reaction', body: '🔥' }, 'Elif'), { title: 'Elif profiline 🔥 bıraktı', body: '' })
  assert.deepEqual(deviceNotificationContent({ ...base, kind: 'reaction', body: '♥' }, 'Selin'), { title: 'Selin mesajına tepki verdi', body: '♥ tepkisi' })
  assert.deepEqual(deviceNotificationContent({ ...base, kind: 'message_request', body: 'Selam' }, 'Mert'), { title: 'Mert mesaj isteği gönderdi', body: 'Selam' })
  assert.deepEqual(deviceNotificationContent({ ...base, kind: 'message', body: 'Naber' }, 'Deniz'), { title: 'Deniz sana yazdı', body: 'Naber' })
  assert.equal(deviceNotificationContent({ ...base, kind: 'profile_reaction', body: '🔥' }, 'Elif', { messagesEnabled: true, reactionsEnabled: false }), null)
  assert.equal(deviceNotificationContent({ ...base, kind: 'message', body: 'x' }, 'Deniz', { messagesEnabled: false, reactionsEnabled: true }), null)
  assert.equal(deviceNotificationContent({ ...base, kind: 'other' as SocialNotification['kind'], body: 'x' }, 'Deniz'), null)
})

test('PC hesap satırı: çalıyorsa parça, değilse "Çevrimiçi"; bağlantı yalnız sorun varken görünür', () => {
  const playing = accountActivity(state())
  assert.equal(playing.tone, 'playing')
  assert.equal(playing.text, 'Gesi Bağları dinliyor')
  assert.equal(playing.title, 'Gesi Bağları · Sanatçı dinliyor')
  const paused = accountActivity(state({ currentUser: user('me', 'online', track('Gesi Bağları', false)) }))
  assert.deepEqual([paused.tone, paused.text], ['online', 'Çevrimiçi'])
  assert.deepEqual([accountActivity(state({ connectionStatus: 'connecting' })).text], ['Bağlanıyor…'])
  const offline = accountActivity(state({ connectionStatus: 'offline' }))
  assert.deepEqual([offline.tone, offline.text], ['offline', 'Bağlantı yok'])
  for (const status of ['online', 'connecting', 'offline'] as const) {
    assert.doesNotMatch(accountActivity(state({ connectionStatus: status })).text, /bağlı/i)
  }
  assert.equal(connectionLine(state({ users: [user('a'), user('b', 'away'), user('c', 'offline')] })).text, '2 kişi çevrimiçi')
  assert.equal(connectionLine(state({ connectionStatus: 'offline' })).text, 'Bağlantı yok')
})

test('oda durumu ve katılma: CANLI, HAZIRLANIYOR, PC ÇEVRİMDIŞI; şerit yalnız katılınabilir odada', () => {
  assert.deepEqual(roomStatus(room('a', 'x')), { label: 'CANLI', tone: 'live' })
  assert.deepEqual(roomStatus(room('a', 'x', { lifecycle: 'waiting' })), { label: 'HAZIRLANIYOR', tone: 'waiting' })
  assert.deepEqual(roomStatus(room('a', 'x', { lifecycle: 'owner_offline' })), { label: 'PC ÇEVRİMDIŞI', tone: 'offline' })
  assert.deepEqual(roomStatus(room('a', 'x', { viewerPlaybackStatus: 'unavailable' })), { label: 'PARÇA AÇILAMADI', tone: 'error' })
  assert.equal(canJoinRoom(room('a', 'x', { memberCount: 8 })), false)
  assert.equal(canJoinRoom(room('a', 'x', { lifecycle: 'owner_offline' })), false)
  assert.equal(canJoinRoom(room('a', 'x', { viewerRole: 'listener' })), false)
  const current = state({ rooms: [room('live', 'ali'), room('off', 'ayse', { lifecycle: 'owner_offline' }), room('mine', 'me', { viewerRole: 'owner' })] })
  assert.equal(roomStripFor(current, 'ali')?.id, 'live')
  assert.equal(roomStripFor(current, 'ayse'), undefined)
  assert.equal(roomStripFor(current, 'me'), undefined)
  assert.equal(roomStripFor(state({ rooms: [room('in', 'ali', { viewerRole: 'listener', memberCount: 8 })] }), 'ali')?.id, 'in')
  const synced = room('s', 'x', { syncSummary: { status: 'synced', roundTripMs: 38.4, driftMs: 12 } })
  assert.equal(roomSyncLabel(synced), 'Senkron · gecikme 38 ms · sapma 12 ms')
  assert.equal(roomSyncLabel(synced, true), 'Senkron · 38 ms')
})

test('Türkçe ekler, gönderim hatası metni ve liste saatleri', () => {
  assert.equal(possessive('Elif Şahin'), 'Elif Şahin’in')
  assert.equal(possessive('Mert Aydın'), 'Mert Aydın’ın')
  assert.equal(possessive('Ayşe'), 'Ayşe’nin')
  assert.equal(possessive('Bora'), 'Bora’nın')
  assert.equal(possessive('Okan Koç'), 'Okan Koç’un')
  assert.equal(dative('Deniz'), 'Deniz’e')
  assert.equal(dative('Bora'), 'Bora’ya')
  assert.equal(accusative('Deniz Kaya'), 'Deniz Kaya’yı')
  assert.equal(accusative('Mert'), 'Mert’i')
  assert.equal(sendFailureReason('offline'), 'bağlantı koptu')
  assert.equal(sendFailureReason('timeout'), 'sunucu yanıt vermedi')
  assert.equal(sendFailureReason('rate_limited'), 'Çok hızlı işlem yaptın. Biraz bekleyip tekrar dene')
  const now = new Date(2026, 9, 10, 21, 45).getTime()
  assert.equal(relativeTimeLabel(now - 20_000, now), 'şimdi')
  assert.equal(relativeTimeLabel(now - 12 * 60_000, now), '12 dk')
  assert.equal(relativeTimeLabel(new Date(2026, 9, 10, 9, 5).getTime(), now), '09:05')
  assert.equal(relativeTimeLabel(new Date(2026, 9, 9, 23, 0).getTime(), now), 'Dün')
  assert.equal(relativeTimeLabel(0, now), '')
})
