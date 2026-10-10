import type { SocialFeedback, SocialState } from './types'

// Shared by the phone/web hook (useSocial) and the Electron Social view
// (desktopSocial/desktopSocialStore), so both surfaces word and handle the
// same gateway results identically.

export type SocialSnapshot = Omit<SocialState, 'connectionStatus'>

export type ExpectedRoomExit = { roomId: string; until: number }

export type SocialAckResult = {
  ok?: boolean
  duplicate?: boolean
  code?: string
  status?: 'joined' | 'left'
}

export const SOCIAL_MESSAGE_MAX_LENGTH = 500
export const SOCIAL_ROOM_MESSAGE_MAX_LENGTH = 280
export const SOCIAL_REPORT_REASON_MAX_LENGTH = 120
export const SOCIAL_REPORT_DETAIL_MAX_LENGTH = 2000
export const SOCIAL_ACK_TIMEOUT_MS = 5_000
export const EXPECTED_ROOM_EXIT_MS = 5_000

export const SOCIAL_TEXT = {
  disconnected: 'Sosyal bağlantı kesildi. Müzik ve telefon kumandası çalışmaya devam ediyor.',
  roomClosed: 'Dinleme odası kapatıldı veya erişimin kaldırıldı.',
  reportSaved: 'Şikâyet güvenli şekilde kaydedildi.',
  roomMessageTimeout: 'Oda mesajı zamanında onaylanmadı; taslağın korunuyor.',
  roomJoined: 'Dinleme odasına katıldın.',
  roomLeft: 'Dinleme odasından ayrıldın.',
  deviceNotificationsOn: 'Sistem bildirimleri açıldı.',
  deviceNotificationsDenied: 'Sistem bildirimi izni verilmedi.',
} as const

export function socialErrorText(code?: string) {
  if (code === 'rate_limited') return 'Çok hızlı işlem yaptın. Biraz bekleyip tekrar dene.'
  if (code === 'message_request_pending') return 'Bu mesaj isteği henüz yanıt bekliyor.'
  if (code === 'message_request_rejected') return 'Bu kullanıcı mesaj isteğini reddetti.'
  if (code === 'message_too_long') return 'Mesaj en fazla 500 karakter olabilir.'
  if (code === 'message_blocked') return 'Bu kullanıcıyla mesajlaşma kullanılamıyor.'
  if (code === 'room_full') return 'Bu oda dolu; en fazla 8 kişi birlikte dinleyebilir.'
  if (code === 'room_not_found') return 'Bu dinleme odası artık açık değil.'
  if (code === 'room_owner') return 'Odanın sahibisin; ayrılmak için odayı kapatabilirsin.'
  if (code === 'room_owner_offline') return 'Oda sahibinin bilgisayarı çevrimdışı. Bağlandığında tekrar deneyebilirsin.'
  if (code === 'room_access_denied') return 'Bu dinleme odasına erişimin bulunmuyor.'
  if (code === 'room_message_too_long') return 'Oda mesajı en fazla 280 karakter olabilir.'
  return 'Sosyal işlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.'
}

// Profile refreshes run in the background, and message/room errors are
// reported through their acknowledgement callbacks; a `social:error` for
// these events must not show a second notice.
const ACK_HANDLED_ERROR_EVENTS = new Set(['profile', 'message', 'room-message', 'room-reaction', 'room-membership'])

export function isAckHandledSocialError(event?: string) {
  return Boolean(event && ACK_HANDLED_ERROR_EVENTS.has(event))
}

export function socialFeedback(tone: SocialFeedback['tone'], text: string, id: string = crypto.randomUUID()): SocialFeedback {
  return { id, tone, text }
}

export function roomMembershipFeedback(result: SocialAckResult, id?: string) {
  return socialFeedback(
    result.ok ? 'success' : 'error',
    result.ok
      ? (result.status === 'left' ? SOCIAL_TEXT.roomLeft : SOCIAL_TEXT.roomJoined)
      : socialErrorText(result.code),
    id,
  )
}

type MergeContext = {
  selectedUserId: string
  expectedRoomExit: ExpectedRoomExit
  deviceEnabled: boolean
  now: number
  newId?: () => string
  // The PC only compares rooms between live gateway snapshots; a sign-out or
  // an offline placeholder must not read as "the room was closed".
  detectRoomLoss?: boolean
}

// Applies a gateway `social:state` snapshot on top of the local one: keeps the
// local conversation selection, preserves this device's notification switch
// and explains an unexpected loss of the active listening room.
export function mergeIncomingSocialSnapshot(previous: SocialSnapshot, next: SocialSnapshot, context: MergeContext) {
  const selected = context.selectedUserId
  const selectedStillExists = next.users.some((user) => user.id === selected)
  const lostActiveRoom = context.detectRoomLoss !== false && Boolean(previous.activeRoomId && !next.activeRoomId)
  const expectedExit = Boolean(
    lostActiveRoom
    && context.expectedRoomExit.roomId === previous.activeRoomId
    && context.expectedRoomExit.until >= context.now
  )
  const snapshot: SocialSnapshot = {
    ...next,
    notificationPreferences: {
      messagesEnabled: next.notificationPreferences?.messagesEnabled !== false,
      reactionsEnabled: next.notificationPreferences?.reactionsEnabled !== false,
      deviceEnabled: context.deviceEnabled,
    },
    mutedUsers: next.mutedUsers || [],
    reportSummary: next.reportSummary || { total: 0, recent: [] },
    feedback: lostActiveRoom && !expectedExit
      ? socialFeedback('info', SOCIAL_TEXT.roomClosed, context.newId?.())
      : previous.feedback,
    selectedUserId: selectedStillExists ? selected : next.selectedUserId,
  }
  return { snapshot, resetExpectedRoomExit: lostActiveRoom && !expectedExit }
}
