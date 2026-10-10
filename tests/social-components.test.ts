import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatView } from '../src/components/social/ChatView'
import { DesktopSocialHub } from '../src/components/social/DesktopSocialHub'
import { MobileSocialHub } from '../src/components/social/MobileSocialHub'
import { NotificationsList } from '../src/components/social/NotificationsView'
import type { SocialHubModel } from '../src/components/social/useSocialHub'
import type { OutboxEntry } from '../src/social/socialOutbox'
import type { SocialActions, SocialNotification, SocialState, SocialTrack, SocialUser } from '../src/social/types'

const noop = () => {}

const actions = new Proxy({}, {
  get: (_target, key) => (key === 'sendMessage' ? async () => ({ ok: true }) : key === 'sendRoomMessage' ? async () => true : noop),
}) as SocialActions

function track(title: string, isPlaying = true): SocialTrack {
  return { id: `t-${title}`, videoId: `v-${title}`, title, artist: 'Barış Manço', duration: 300, position: 40, cover: 1, isPlaying }
}

function user(id: string, displayName: string, presence: SocialUser['presence'] = 'online', currentTrack?: SocialTrack): SocialUser {
  return { id, displayName, handle: `@${id}`, initials: displayName.slice(0, 2), avatarTone: 2, presence, currentTrack, reactionCount: 4 }
}

function state(patch: Partial<SocialState> = {}): SocialState {
  return {
    connectionStatus: 'online',
    authentication: { configured: true, required: true, authenticated: true, user: { id: 'me', displayName: 'Ediz Ege', handle: '@edizege', initials: 'EE', avatarTone: 0 } },
    currentUser: user('me', 'Ediz Ege', 'online', track('Gesi Bağları')),
    privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' },
    currentDeviceCount: 2,
    companionConnected: true,
    users: [user('mert', 'Mert Aydın'), user('kerem', 'Kerem Yıldız', 'away'), user('bora', 'Bora Demir', 'offline'), user('deniz', 'Deniz Kaya', 'online', track('Blinding Lights'))],
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

function hub(entries: OutboxEntry[] = []): SocialHubModel {
  return {
    outbox: { entries, send: () => null, retry: () => false },
    toast: null,
    showToast: noop,
    dismissToast: noop,
    drafts: {},
    setDraft: noop,
    hearted: new Set(),
    sendHeart: noop,
    leaving: new Set(),
    gone: new Set(),
    respondToRequest: noop,
    reportUser: noop,
  } as unknown as SocialHubModel
}

const chat = (current: SocialState, userId: string, options: { desktop?: boolean; entries?: OutboxEntry[] } = {}) => renderToStaticMarkup(
  h(ChatView, { state: current, actions, hub: hub(options.entries), userId, desktop: Boolean(options.desktop), onBack: noop }),
)

test('bekleyen gelen istek sohbeti istek panelini gösterir, "İlk mesajı sen gönder" göstermez', () => {
  const current = state({ messageRequests: [{ userId: 'mert', direction: 'incoming', preview: 'Selam! Islak Islak’ı nereden buldun?', sentAt: Date.now() - 60_000 }] })
  for (const desktop of [false, true]) {
    const html = chat(current, 'mert', { desktop })
    assert.match(html, /Selam! Islak Islak’ı nereden buldun\?/)
    assert.match(html, /Mert sana yazmak istiyor/)
    assert.match(html, /Cevap yazmak için önce kabul et\. Reddedersen istek ve mesajları silinir\./)
    assert.match(html, />Reddet</)
    assert.match(html, />Kabul et</)
    assert.match(html, />Şikâyet et</)
    assert.match(html, />Engelle</)
    assert.match(html, /Mesaj isteği/)
    assert.doesNotMatch(html, /İlk mesajı sen gönder/)
    assert.doesNotMatch(html, /aria-label="Mesajı gönder"/)
  }
})

test('sohbet başlığı gerçek varlık durumunu gösterir', () => {
  assert.match(chat(state(), 'kerem'), /class="is-away">Uzakta</)
  assert.match(chat(state(), 'bora'), /class="is-offline">Çevrimdışı</)
  assert.match(chat(state(), 'mert'), /class="is-online">Çevrimiçi</)
  assert.doesNotMatch(chat(state(), 'kerem'), />Çevrimiçi</)
})

test('giden bekleyen istekte cevap kutusu yerine bilgi metni', () => {
  const current = state({
    conversations: { bora: [{ id: 'b1', senderId: 'me', text: 'Merhaba', sentAt: Date.now() - 1_000, reactions: [] }] },
    messageRequests: [{ userId: 'bora', direction: 'outgoing', preview: 'Merhaba', sentAt: Date.now() - 1_000 }],
  })
  const html = chat(current, 'bora')
  assert.match(html, /Mesaj isteğin gönderildi\./)
  assert.match(html, /İsteğin yanıt bekliyor/)
  assert.doesNotMatch(html, /aria-label="Mesajı gönder"/)
})

test('gönderilemeyen mesaj balonda kalır: "Gönderilemedi · Tekrar dene"; gönderilen "Gönderiliyor…"', () => {
  const entries: OutboxEntry[] = [
    { clientMessageId: 'c1', userId: 'deniz', text: 'Odayı açınca haber veririm', createdAt: Date.now(), status: 'failed', code: 'offline', attempts: 1 },
    { clientMessageId: 'c2', userId: 'deniz', text: 'Geliyorum', createdAt: Date.now(), status: 'sending', attempts: 1 },
  ]
  const phone = chat(state(), 'deniz', { entries })
  assert.match(phone, /Odayı açınca haber veririm/)
  assert.match(phone, /Gönderilemedi/)
  assert.match(phone, />Tekrar dene</)
  assert.match(phone, /Gönderiliyor…/)
  assert.match(chat(state(), 'deniz', { desktop: true, entries }), /Gönderilemedi: bağlantı koptu/)
  // Delivered (id == clientMessageId in the snapshot) is drawn once, as the real message.
  const delivered = state({ conversations: { deniz: [{ id: 'c1', senderId: 'me', text: 'Odayı açınca haber veririm', sentAt: Date.now(), reactions: [] }] } })
  const html = chat(delivered, 'deniz', { entries })
  assert.equal(html.split('>Odayı açınca haber veririm<').length - 1, 1)
  assert.doesNotMatch(html, /Gönderilemedi/)
})

test('bildirimler: profile_reaction görünür, bilinmeyen tür sessizce atlanır, telefon bandı ve PC Windows satırı', () => {
  const notifications: SocialNotification[] = [
    { id: 'p', kind: 'profile_reaction', actorId: 'deniz', body: '🔥', createdAt: Date.now() - 60_000, read: false },
    { id: 'x', kind: 'mystery' as SocialNotification['kind'], actorId: 'deniz', body: 'GİZEMLİ', createdAt: Date.now(), read: false },
  ]
  const current = state({ notifications })
  const phone = renderToStaticMarkup(h(NotificationsList, { state: current, actions, onOpenTarget: noop, onOpenSettings: noop, desktop: false }))
  assert.match(phone, /<b>Deniz Kaya<\/b> profiline 🔥 bıraktı/)
  assert.doesNotMatch(phone, /GİZEMLİ/)
  assert.match(phone, /Telefon bildirimleri kapalı/)
  assert.match(phone, /Bildirim ayarları/)
  assert.match(phone, />Yeni</)
  const desktop = renderToStaticMarkup(h(NotificationsList, { state: current, actions, onOpenTarget: noop, onOpenSettings: noop, desktop: true }))
  assert.match(desktop, /Windows bildirimleri kapalı/)
  assert.match(desktop, />Ayarlar</)
})

test('PC: dört bölümlü sol menü ve hesap satırı; bağlantı yalnız sorun varken yazılır', () => {
  const html = renderToStaticMarkup(h(DesktopSocialHub, { state: state(), actions }))
  for (const label of ['Dinleyenler', 'Mesajlar', 'Odalar', 'Bildirimler']) assert.match(html, new RegExp(`class="rs-side-label">${label}<`))
  assert.match(html, /Gesi Bağları dinliyor/)
  assert.match(html, /title="Gesi Bağları · Barış Manço dinliyor"/)
  assert.doesNotMatch(html, /Ritim Sosyal bağlı|Ritim Social bağlantısı kuruldu/)
  assert.doesNotMatch(html, /<select/)

  const offline = renderToStaticMarkup(h(DesktopSocialHub, { state: state({ connectionStatus: 'offline', lastOnlineAt: new Date(2026, 9, 10, 21, 50).getTime() }), actions }))
  assert.match(offline, /Bağlantı yok/)
  assert.match(offline, /Ritim Sosyal’e ulaşılamıyor/)
  assert.match(offline, /Müzik ve telefon kumandası çalışmaya devam ediyor/)
  assert.match(offline, /Son başarılı bağlantı 21:50/)

  const signedOut = renderToStaticMarkup(h(DesktopSocialHub, { state: state({ authentication: { configured: true, required: true, authenticated: false } }), actions }))
  assert.match(signedOut, /Google ile giriş yap/)
})

test('telefon: segmentler, zil rozeti, ayar kısayolu; gizlilik seçicileri sosyal ekranda yok; oturum yok adımları', () => {
  const current = state({
    notifications: [{ id: 'n', kind: 'message', actorId: 'deniz', body: 'x', createdAt: Date.now(), read: false }],
    unreadCounts: { deniz: 2 },
    messageRequests: [{ userId: 'mert', direction: 'incoming', preview: 'Selam', sentAt: Date.now() }],
  })
  const html = renderToStaticMarkup(h(MobileSocialHub, { state: current, actions, onOpenSettings: noop }))
  for (const label of ['Dinleyenler', 'Mesajlar', 'Odalar']) assert.match(html, new RegExp(`>${label}`))
  assert.match(html, /aria-label="Bildirimler, 1 okunmamış"/)
  assert.match(html, /aria-label="Mesajlar, 3 yeni"/)
  assert.match(html, /aria-label="Sosyal ayarları"/)
  assert.doesNotMatch(html, /<select|görünürlüğü/)
  const signedOut = renderToStaticMarkup(h(MobileSocialHub, { state: state({ connectionStatus: 'offline' }), actions, signedOut: true }))
  assert.match(signedOut, /Bilgisayarda Ritim › Sosyal’i aç/)
  assert.match(signedOut, /Google ile giriş yap/)
  assert.match(signedOut, /Bu telefon kendiliğinden eklenir/)
  assert.match(signedOut, />Yeniden dene</)
})
