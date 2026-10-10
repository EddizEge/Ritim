import { socialErrorText } from './socialShared'
import type {
  SocialConnectionStatus,
  SocialMessage,
  SocialMessageRequest,
  SocialNotification,
  SocialNotificationKind,
  SocialNotificationPreferences,
  SocialRoom,
  SocialState,
  SocialTrack,
  SocialUser,
} from './types'

// Pure view rules shared by the phone and PC social screens
// (src/components/social). Kept free of React so they can be unit tested.

export const MESSAGE_REACTIONS = ['♥', '🔥', '😂', '👍'] as const
export const ROOM_REACTIONS = ['♥', '🔥', '👏', '🎵'] as const
export const REPORT_REASONS = ['Spam', 'Taciz', 'Uygunsuz içerik', 'Diğer'] as const
export const REACTION_NAMES: Record<string, string> = {
  '♥': 'Kalp',
  '🔥': 'Ateş',
  '😂': 'Gülme',
  '👍': 'Beğeni',
  '👏': 'Alkış',
  '🎵': 'Nota',
}

export type PresenceTone = 'online' | 'away' | 'offline'

export function presenceLabel(presence: SocialUser['presence'] | undefined): { text: string; tone: PresenceTone } {
  if (presence === 'online') return { text: 'Çevrimiçi', tone: 'online' }
  if (presence === 'away') return { text: 'Uzakta', tone: 'away' }
  return { text: 'Çevrimdışı', tone: 'offline' }
}

export function isActive(user: Pick<SocialUser, 'presence'>) {
  return user.presence === 'online' || user.presence === 'away'
}

export function isListening(user: Pick<SocialUser, 'presence' | 'currentTrack'>) {
  return isActive(user) && Boolean(user.currentTrack?.isPlaying)
}

export function normalizeQuery(query: string) {
  return query.trim().toLocaleLowerCase('tr')
}

export function matchesSocialQuery(user: SocialUser, query: string) {
  if (!query) return true
  const track = user.currentTrack
  return [user.displayName, user.handle, track?.title, track?.artist]
    .filter(Boolean)
    .some((value) => value?.toLocaleLowerCase('tr').includes(query))
}

// "Şu an dinliyor" = active and playing; "Çevrimiçi" = active but paused or
// idle; offline people stay reachable in their own section.
export function groupListeners(users: SocialUser[], query = '') {
  const normalized = normalizeQuery(query)
  const visible = users.filter((user) => matchesSocialQuery(user, normalized))
  return {
    listening: visible.filter(isListening),
    online: visible.filter((user) => isActive(user) && !isListening(user)),
    offline: visible.filter((user) => !isActive(user)),
  }
}

export function activeUserCount(users: SocialUser[]) {
  return users.filter(isActive).length
}

export function idleActivityLine(user: SocialUser) {
  const track = user.currentTrack
  if (track?.title && !track.isPlaying && isActive(user)) return `Duraklattı · ${track.title}`
  if (user.presence === 'away') return 'Uzakta · bir şey dinlemiyor'
  if (user.presence === 'offline') return track?.title ? `Son dinlediği · ${track.title}` : 'Çevrimdışı'
  return 'Çevrimiçi · bir şey dinlemiyor'
}

export function firstName(displayName: string) {
  return displayName.trim().split(/\s+/)[0] || displayName
}

const BACK_VOWELS = 'aıou'
const VOWELS = 'aeıioöuü'

function lastVowel(word: string) {
  const lower = word.toLocaleLowerCase('tr')
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    if (VOWELS.includes(lower[index])) return lower[index]
  }
  return 'e'
}

function endsWithVowel(word: string) {
  const lower = word.toLocaleLowerCase('tr')
  return VOWELS.includes(lower.at(-1) || '')
}

// Turkish genitive with an apostrophe: "Elif Şahin’in", "Mert Aydın’ın", "Ayşe’nin".
export function possessive(name: string) {
  const vowel = lastVowel(name)
  const suffix = vowel === 'a' || vowel === 'ı' ? 'ın' : vowel === 'o' || vowel === 'u' ? 'un' : vowel === 'ö' || vowel === 'ü' ? 'ün' : 'in'
  return `${name}’${endsWithVowel(name) ? 'n' : ''}${suffix}`
}

// Turkish accusative with an apostrophe: "Deniz Kaya’yı", "Mert’i", "Ayşe’yi".
export function accusative(name: string) {
  const vowel = lastVowel(name)
  const suffix = vowel === 'a' || vowel === 'ı' ? 'ı' : vowel === 'o' || vowel === 'u' ? 'u' : vowel === 'ö' || vowel === 'ü' ? 'ü' : 'i'
  return `${name}’${endsWithVowel(name) ? 'y' : ''}${suffix}`
}

// Turkish dative with an apostrophe: "Deniz’e", "Mert’e", "Ayşe’ye", "Bora’ya".
export function dative(name: string) {
  const suffix = BACK_VOWELS.includes(lastVowel(name)) ? 'a' : 'e'
  return `${name}’${endsWithVowel(name) ? 'y' : ''}${suffix}`
}

// Phase 1 PC tab rule, also used by the phone's Sosyal tab and the Electron app
// bar: unread messages plus incoming message requests.
export function messagesBadgeCount(state: Pick<SocialState, 'unreadCounts' | 'messageRequests'>) {
  const unread = Object.values(state.unreadCounts || {})
    .reduce((total, count) => total + (Number.isFinite(count) && count > 0 ? count : 0), 0)
  return unread + (state.messageRequests || []).filter((request) => request.direction === 'incoming').length
}

const KNOWN_NOTIFICATION_KINDS = new Set<SocialNotificationKind>(['message_request', 'message', 'reaction', 'profile_reaction'])

export function isKnownNotification(notification: SocialNotification) {
  return KNOWN_NOTIFICATION_KINDS.has(notification?.kind)
}

export function unreadNotificationCount(state: Pick<SocialState, 'notifications'>) {
  return (state.notifications || []).filter((notification) => isKnownNotification(notification) && !notification.read).length
}

export function placeholderUser(id: string): SocialUser {
  return {
    id,
    displayName: 'Ritim kullanıcısı',
    handle: '',
    initials: 'R',
    avatarTone: 0,
    presence: 'offline',
    reactionCount: 0,
  }
}

export function findUser(state: Pick<SocialState, 'users' | 'mutedUsers' | 'blockedUsers' | 'currentUser'>, id: string | undefined) {
  if (!id) return undefined
  return state.users.find((user) => user.id === id)
    || state.mutedUsers?.find((user) => user.id === id)
    || state.blockedUsers?.find((user) => user.id === id)
    || (state.currentUser?.id === id ? state.currentUser : undefined)
}

export function userFor(state: Pick<SocialState, 'users' | 'mutedUsers' | 'blockedUsers' | 'currentUser'>, id: string | undefined) {
  return findUser(state, id) || placeholderUser(id || '')
}

export function requestWith(state: Pick<SocialState, 'messageRequests'>, userId: string | undefined, direction: SocialMessageRequest['direction']) {
  if (!userId) return undefined
  return state.messageRequests.find((request) => request.userId === userId && request.direction === direction)
}

export type ConversationSummary = {
  userId: string
  user: SocialUser
  last?: SocialMessage
  preview: string
  time: number
  unread: number
  muted: boolean
  outgoingPending: boolean
}

// Accepted and outgoing-pending conversations, newest first. Incoming requests
// are listed separately and blocked people are left out.
export function conversationSummaries(state: SocialState): ConversationSummary[] {
  const blocked = new Set(state.blockedUsers.map((user) => user.id))
  const incoming = new Set(state.messageRequests.filter((request) => request.direction === 'incoming').map((request) => request.userId))
  const outgoing = new Map(state.messageRequests.filter((request) => request.direction === 'outgoing').map((request) => [request.userId, request]))
  const ids = new Set<string>()
  for (const [userId, messages] of Object.entries(state.conversations || {})) {
    if (messages?.length) ids.add(userId)
  }
  for (const userId of outgoing.keys()) ids.add(userId)
  const summaries: ConversationSummary[] = []
  for (const userId of ids) {
    if (blocked.has(userId) || incoming.has(userId) || userId === state.currentUser.id) continue
    const messages = state.conversations[userId] || []
    const last = messages.at(-1)
    const request = outgoing.get(userId)
    const own = last ? last.senderId === state.currentUser.id : Boolean(request)
    const text = last?.text || request?.preview || ''
    summaries.push({
      userId,
      user: userFor(state, userId),
      last,
      preview: text ? (own ? `Sen: ${text}` : text) : '',
      time: last?.sentAt || request?.sentAt || 0,
      unread: Math.max(0, Number(state.unreadCounts[userId]) || 0),
      muted: state.mutedUserIds.includes(userId),
      outgoingPending: Boolean(request),
    })
  }
  return summaries.sort((left, right) => right.time - left.time)
}

export function incomingRequests(state: SocialState) {
  const blocked = new Set(state.blockedUsers.map((user) => user.id))
  return state.messageRequests
    .filter((request) => request.direction === 'incoming' && !blocked.has(request.userId))
    .map((request) => ({ ...request, user: userFor(state, request.userId) }))
    .sort((left, right) => right.sentAt - left.sentAt)
}

const clockFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' })
const weekdayFormat = new Intl.DateTimeFormat('tr-TR', { weekday: 'short' })
const shortDateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' })
const longDateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' })

export function clockLabel(timestamp: number) {
  return clockFormat.format(timestamp)
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function daysAgo(timestamp: number, now: number) {
  return Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000)
}

// List timestamps: "şimdi", "12 dk", "21:41", "Dün", "Pzt", "3 Eki".
export function relativeTimeLabel(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const elapsed = now - timestamp
  if (elapsed < 60_000) return 'şimdi'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} dk`
  const days = daysAgo(timestamp, now)
  if (days <= 0) return clockLabel(timestamp)
  if (days === 1) return 'Dün'
  if (days < 7) return weekdayFormat.format(timestamp).replace('.', '')
  return shortDateFormat.format(timestamp)
}

export function dayLabel(timestamp: number, now = Date.now()) {
  const days = daysAgo(timestamp, now)
  if (days <= 0) return 'Bugün'
  if (days === 1) return 'Dün'
  return longDateFormat.format(timestamp)
}

export type NotificationTarget =
  | { kind: 'request'; userId: string }
  | { kind: 'chat'; userId: string }
  | { kind: 'profile'; userId: string }

export type NotificationView = {
  id: string
  kind: SocialNotificationKind
  actor: SocialUser
  read: boolean
  createdAt: number
  action: string
  quote?: string
  badge: { kind: 'request' | 'message' | 'emoji'; emoji?: string }
  target: NotificationTarget
}

export function notificationView(notification: SocialNotification, state: SocialState): NotificationView | null {
  if (!isKnownNotification(notification)) return null
  const actorId = notification.actorId || ''
  const actor = userFor(state, actorId)
  const base = { id: notification.id, kind: notification.kind, actor, read: Boolean(notification.read), createdAt: Number(notification.createdAt) || 0 }
  if (notification.kind === 'message_request') {
    const pending = Boolean(requestWith(state, actorId, 'incoming'))
    return { ...base, action: 'mesaj isteği gönderdi', quote: notification.body, badge: { kind: 'request' }, target: { kind: pending ? 'request' : 'chat', userId: actorId } }
  }
  if (notification.kind === 'message') {
    return { ...base, action: 'sana yazdı', quote: notification.body, badge: { kind: 'message' }, target: { kind: 'chat', userId: actorId } }
  }
  if (notification.kind === 'reaction') {
    const message = notification.messageId ? state.conversations[actorId]?.find((item) => item.id === notification.messageId) : undefined
    return { ...base, action: `mesajına ${notification.body} verdi`, quote: message?.text, badge: { kind: 'emoji', emoji: notification.body }, target: { kind: 'chat', userId: actorId } }
  }
  return { ...base, action: `profiline ${notification.body} bıraktı`, badge: { kind: 'emoji', emoji: notification.body }, target: { kind: 'profile', userId: actorId } }
}

export function notificationViews(state: SocialState) {
  return state.notifications
    .map((notification) => notificationView(notification, state))
    .filter((view): view is NotificationView => Boolean(view))
    .sort((left, right) => right.createdAt - left.createdAt)
}

// "Yeni" holds what was unread when the screen opened (plus anything unread
// since), so marking everything read does not reshuffle the list.
export function groupNotifications(views: NotificationView[], freshIds: ReadonlySet<string>) {
  const fresh: NotificationView[] = []
  const earlier: NotificationView[] = []
  for (const view of views) (!view.read || freshIds.has(view.id) ? fresh : earlier).push(view)
  return { fresh, earlier }
}

// Text of a system notification (phone LocalNotifications / web Notification);
// electron/social-notifications.cjs applies the same rules on the PC.
export function deviceNotificationContent(
  notification: SocialNotification,
  actorName: string,
  preferences?: Pick<SocialNotificationPreferences, 'messagesEnabled' | 'reactionsEnabled'>,
): { title: string; body: string } | null {
  if (!isKnownNotification(notification)) return null
  const reaction = notification.kind === 'reaction' || notification.kind === 'profile_reaction'
  if (reaction && preferences?.reactionsEnabled === false) return null
  if (!reaction && preferences?.messagesEnabled === false) return null
  if (notification.kind === 'message_request') return { title: `${actorName} mesaj isteği gönderdi`, body: notification.body }
  if (notification.kind === 'message') return { title: `${actorName} sana yazdı`, body: notification.body }
  if (notification.kind === 'reaction') return { title: `${actorName} mesajına tepki verdi`, body: `${notification.body} tepkisi` }
  return { title: `${actorName} profiline ${notification.body} bıraktı`, body: '' }
}

export type ConnectionTone = 'online' | 'connecting' | 'offline'

export function connectionTone(status: SocialConnectionStatus): ConnectionTone {
  if (status === 'online' || status === 'preview') return 'online'
  return status === 'connecting' ? 'connecting' : 'offline'
}

export function connectionLine(state: Pick<SocialState, 'connectionStatus' | 'users'>) {
  const tone = connectionTone(state.connectionStatus)
  if (tone === 'connecting') return { tone, text: 'Bağlanıyor…' }
  if (tone === 'offline') return { tone, text: 'Bağlantı yok' }
  return { tone, text: `${activeUserCount(state.users)} kişi çevrimiçi` }
}

// PC account row: what you are playing, or "Çevrimiçi"; the connection only
// shows up while it is a problem.
export function accountActivity(state: Pick<SocialState, 'connectionStatus' | 'currentUser'>, localTrack?: SocialTrack) {
  const tone = connectionTone(state.connectionStatus)
  if (tone === 'connecting') return { tone: 'connecting' as const, text: 'Bağlanıyor…', title: 'Ritim Sosyal’e bağlanıyor…' }
  if (tone === 'offline') return { tone: 'offline' as const, text: 'Bağlantı yok', title: 'Ritim Sosyal’e ulaşılamıyor' }
  const track = localTrack || state.currentUser.currentTrack
  if (track?.isPlaying && track.title) {
    const text = `${track.title} dinliyor`
    return { tone: 'playing' as const, text, title: track.artist ? `${track.title} · ${track.artist} dinliyor` : text }
  }
  return { tone: 'online' as const, text: 'Çevrimiçi', title: 'Çevrimiçi' }
}

export type RoomStatusTone = 'live' | 'waiting' | 'offline' | 'error'

export function roomStatus(room: SocialRoom): { label: string; tone: RoomStatusTone } {
  if (room.viewerPlaybackStatus === 'unavailable') return { label: 'PARÇA AÇILAMADI', tone: 'error' }
  if (room.lifecycle === 'owner_offline') return { label: 'PC ÇEVRİMDIŞI', tone: 'offline' }
  if (room.lifecycle === 'waiting') return { label: 'HAZIRLANIYOR', tone: 'waiting' }
  return { label: 'CANLI', tone: 'live' }
}

export function canJoinRoom(room: SocialRoom) {
  return !room.viewerRole && room.lifecycle !== 'owner_offline' && room.memberCount < room.maxMembers
}

export function ownRoom(state: Pick<SocialState, 'rooms'>) {
  return state.rooms.find((room) => room.viewerRole === 'owner')
}

export function openRooms(state: Pick<SocialState, 'rooms'>) {
  return state.rooms.filter((room) => room.viewerRole !== 'owner')
}

// The "<oda> odasında · n/8 — Katıl" strip on a listener card: only for a
// room you can join right now (or are already in).
export function roomStripFor(state: Pick<SocialState, 'rooms'>, userId: string) {
  const room = state.rooms.find((candidate) => candidate.ownerId === userId && candidate.viewerRole !== 'owner')
  if (!room) return undefined
  return canJoinRoom(room) || room.viewerRole === 'listener' ? room : undefined
}

// `compact` (phone) keeps the status and round trip: "Senkron · 38 ms".
export function roomSyncLabel(room: SocialRoom, compact = false) {
  const summary = room.syncSummary
  if (!summary) return ''
  if (summary.status === 'waiting') return 'Senkron bekleniyor'
  if (summary.status === 'unavailable') return 'Senkron kullanılamıyor'
  const status = summary.status === 'corrected' ? 'Düzeltildi' : 'Senkron'
  const roundTripMs = Number.isFinite(summary.roundTripMs) ? Math.round(summary.roundTripMs || 0) : undefined
  if (compact) return roundTripMs === undefined ? status : `${status} · ${roundTripMs} ms`
  const roundTrip = roundTripMs === undefined ? '' : `gecikme ${roundTripMs} ms`
  const drift = Number.isFinite(summary.driftMs) ? `sapma ${Math.round(summary.driftMs || 0)} ms` : ''
  return [status, roundTrip, drift].filter(Boolean).join(' · ')
}

export function roomOwner(state: SocialState, room: SocialRoom) {
  return room.ownerId === state.currentUser.id ? state.currentUser : userFor(state, room.ownerId)
}

// What the room plays: the owner's current track when it matches the room's
// video (or when no playback was published yet).
export function roomTrack(state: SocialState, room: SocialRoom): SocialTrack | undefined {
  const track = roomOwner(state, room).currentTrack
  if (!track) return undefined
  if (room.playback?.videoId && track.videoId && room.playback.videoId !== track.videoId) return undefined
  return track
}

export function sendFailureReason(code?: string) {
  if (!code || code === 'offline' || code === 'ipc_failed') return 'bağlantı koptu'
  if (code === 'timeout') return 'sunucu yanıt vermedi'
  return socialErrorText(code).replace(/\.$/, '')
}
