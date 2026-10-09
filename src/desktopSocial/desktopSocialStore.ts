import {
  EXPECTED_ROOM_EXIT_MS,
  SOCIAL_MESSAGE_MAX_LENGTH,
  SOCIAL_REPORT_DETAIL_MAX_LENGTH,
  SOCIAL_REPORT_REASON_MAX_LENGTH,
  SOCIAL_ROOM_MESSAGE_MAX_LENGTH,
  SOCIAL_TEXT,
  isAckHandledSocialError,
  mergeIncomingSocialSnapshot,
  messageAckFeedback,
  roomMembershipFeedback,
  socialErrorText,
  socialFeedback,
  type ExpectedRoomExit,
  type SocialSnapshot,
} from '../social/socialShared'
import type {
  SocialActions,
  SocialAuthenticationSummary,
  SocialConnectionStatus,
  SocialFeedback,
  SocialMessageReaction,
  SocialNotificationPreferences,
  SocialPrivacy,
  SocialRoomReaction,
  SocialState,
} from '../social/types'

// Result of `window.ritimSocial.action` (electron/social-bridge.cjs).
export type DesktopSocialActionResult = {
  ok: boolean
  code?: string
  duplicate?: boolean
  status?: 'joined' | 'left'
  acknowledged?: boolean
  enabled?: boolean
  supported?: boolean
}

export type DesktopSocialIncomingState = Partial<SocialSnapshot> & {
  connectionStatus?: SocialConnectionStatus
  authentication?: SocialAuthenticationSummary
  viewVisible?: boolean
}

export type DesktopSocialEvent =
  | { kind: 'error'; code?: string; event?: string }
  | { kind: 'report-saved' }

// Exposed by electron/social-preload.cjs.
export type RitimSocialBridge = {
  getState: () => Promise<DesktopSocialIncomingState | null | undefined>
  action: (type: string, payload?: Record<string, unknown>) => Promise<DesktopSocialActionResult>
  getAppearance: () => Promise<unknown>
  onState: (callback: (state: DesktopSocialIncomingState) => void) => () => void
  onEvent: (callback: (event: DesktopSocialEvent) => void) => () => void
  onVisibility: (callback: (visible: boolean) => void) => () => void
  onAppearance: (callback: (preferences: unknown) => void) => () => void
}

type StoreOptions = {
  now?: () => number
  newId?: () => string
}

// Events emitted by the PC's own background work (profile, room playback,
// clock sync) or answered through acknowledgements never become notices.
const BACKGROUND_ERROR_EVENTS = new Set(['join', 'room-playback', 'room-playback-result', 'clock'])

const DESKTOP_TEXT = {
  signInStarted: 'Google girişi tarayıcında açıldı; tamamlayınca Sosyal burada bağlanacak.',
  signedIn: 'Google hesabın Ritim Social’a bağlandı.',
  signInFailed: 'Google ile giriş tamamlanamadı. Tekrar deneyebilirsin.',
  signedOut: 'Ritim Social hesabından çıkış yapıldı.',
  signOutFailed: 'Ritim Social oturumu kapatılamadı. Tekrar dene.',
  deviceNotificationsOff: 'Sistem bildirimleri kapatıldı.',
  deviceNotificationsUnsupported: 'Bu bilgisayarda sistem bildirimleri desteklenmiyor.',
} as const

const CONNECTION_STATUSES = new Set<SocialConnectionStatus>(['preview', 'connecting', 'online', 'offline'])

function emptyState(): SocialState {
  return {
    connectionStatus: 'connecting',
    currentUser: {
      id: '',
      displayName: 'Ritim PC',
      handle: '@ritimpc',
      initials: 'PC',
      avatarTone: 0,
      presence: 'online',
      reactionCount: 0,
    },
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
  }
}

function snapshotFrom(incoming: DesktopSocialIncomingState, fallback: SocialState): SocialSnapshot {
  const base = emptyState()
  return {
    currentUser: incoming.currentUser || fallback.currentUser,
    privacy: incoming.privacy || base.privacy,
    currentDeviceCount: Number(incoming.currentDeviceCount) || 1,
    companionConnected: Boolean(incoming.companionConnected),
    users: incoming.users || [],
    rooms: incoming.rooms || [],
    roomMessages: incoming.roomMessages || {},
    roomReactions: incoming.roomReactions || {},
    conversations: incoming.conversations || {},
    unreadCounts: incoming.unreadCounts || {},
    messageRequests: incoming.messageRequests || [],
    notifications: incoming.notifications || [],
    notificationPreferences: incoming.notificationPreferences || base.notificationPreferences,
    mutedUserIds: incoming.mutedUserIds || [],
    mutedUsers: incoming.mutedUsers || [],
    blockedUsers: incoming.blockedUsers || [],
    reportSummary: incoming.reportSummary || base.reportSummary,
    selectedUserId: incoming.selectedUserId || '',
    listeningWithUserId: incoming.listeningWithUserId,
    activeRoomId: incoming.activeRoomId,
  }
}

// Holds the Electron Social view's state and implements SocialActions over the
// main-process IPC bridge, mirroring useSocial's feedback and draft rules.
export function createDesktopSocialStore(bridge: RitimSocialBridge, options: StoreOptions = {}) {
  const now = options.now || (() => Date.now())
  const newId = options.newId || (() => crypto.randomUUID())
  const listeners = new Set<() => void>()
  let state: SocialState = emptyState()
  let expectedRoomExit: ExpectedRoomExit = { roomId: '', until: 0 }
  let viewVisible = true
  let receivedState = false
  const pendingReads = new Set<string>()

  function emit() {
    for (const listener of listeners) listener()
  }

  function update(patch: Partial<SocialState>) {
    state = { ...state, ...patch }
    emit()
  }

  function notify(tone: SocialFeedback['tone'], text: string) {
    update({ feedback: socialFeedback(tone, text, newId()) })
  }

  async function send(type: string, payload?: Record<string, unknown>): Promise<DesktopSocialActionResult> {
    try {
      const result = await bridge.action(type, payload)
      return result && typeof result === 'object' ? result : { ok: false, code: 'ipc_failed' }
    } catch {
      return { ok: false, code: 'ipc_failed' }
    }
  }

  // Fire-and-forget gateway events report problems through `social:error`;
  // only local failures (not offline, which the banner already shows) are
  // surfaced here.
  async function sendWithoutAck(type: string, payload?: Record<string, unknown>) {
    const result = await send(type, payload)
    if (!result.ok && result.code !== 'offline') notify('error', socialErrorText(result.code))
    return result
  }

  function online() {
    return state.connectionStatus === 'online'
  }

  function expectRoomExit(roomId?: string) {
    if (roomId) expectedRoomExit = { roomId, until: now() + EXPECTED_ROOM_EXIT_MS }
  }

  function flushPendingReads() {
    if (!viewVisible || !online()) return
    for (const userId of pendingReads) {
      pendingReads.delete(userId)
      if (state.unreadCounts[userId]) void sendWithoutAck('read', { targetUserId: userId })
    }
  }

  function applyIncoming(incoming: DesktopSocialIncomingState | null | undefined) {
    if (!incoming || typeof incoming !== 'object') return
    const status = CONNECTION_STATUSES.has(incoming.connectionStatus as SocialConnectionStatus)
      ? incoming.connectionStatus as SocialConnectionStatus
      : 'connecting'
    const previousStatus = state.connectionStatus
    const { snapshot, resetExpectedRoomExit } = mergeIncomingSocialSnapshot(state, snapshotFrom(incoming, state), {
      selectedUserId: state.selectedUserId,
      expectedRoomExit,
      deviceEnabled: incoming.notificationPreferences?.deviceEnabled === true,
      now: now(),
      newId,
      // Placeholder states (connecting, offline, after sign-out) carry no
      // gateway rooms; only a live snapshot can tell that a room was closed.
      detectRoomLoss: status === 'online',
    })
    if (resetExpectedRoomExit) expectedRoomExit = { roomId: '', until: 0 }
    receivedState = true
    state = {
      ...snapshot,
      feedback: previousStatus === 'online' && status === 'offline'
        ? socialFeedback('info', SOCIAL_TEXT.disconnected, newId())
        : snapshot.feedback,
      connectionStatus: status,
      authentication: incoming.authentication,
    }
    if (typeof incoming.viewVisible === 'boolean') viewVisible = incoming.viewVisible
    emit()
    flushPendingReads()
  }

  function handleEvent(event: DesktopSocialEvent) {
    if (!event || typeof event !== 'object') return
    if (event.kind === 'report-saved') {
      notify('success', SOCIAL_TEXT.reportSaved)
      return
    }
    if (event.kind !== 'error') return
    if (isAckHandledSocialError(event.event) || BACKGROUND_ERROR_EVENTS.has(event.event || '')) return
    notify('error', socialErrorText(event.code))
  }

  function setVisible(visible: boolean) {
    viewVisible = visible === true
    flushPendingReads()
  }

  const actions: Required<SocialActions> = {
    selectUser(userId: string) {
      update({ selectedUserId: userId })
    },
    reactToUser(userId: string, reaction = '♥') {
      void sendWithoutAck('reaction', { targetUserId: userId, reaction })
    },
    async sendMessage(userId: string, text: string) {
      const cleanText = text.trim().slice(0, SOCIAL_MESSAGE_MAX_LENGTH)
      if (!cleanText) return false
      if (!online()) {
        notify('error', SOCIAL_TEXT.messageOffline)
        return false
      }
      const result = await send('message', { targetUserId: userId, text: cleanText, clientMessageId: newId() })
      if (result.code === 'offline') notify('error', SOCIAL_TEXT.messageOffline)
      else if (result.code === 'timeout') notify('error', SOCIAL_TEXT.messageTimeout)
      else update({ feedback: messageAckFeedback(result, newId()) })
      return result.ok === true
    },
    markConversationRead(userId: string) {
      if (!online()) return
      // A hidden Social view stays mounted; reading waits until it is shown.
      if (!viewVisible) {
        pendingReads.add(userId)
        return
      }
      void sendWithoutAck('read', { targetUserId: userId })
    },
    respondToMessageRequest(userId: string, action: 'accept' | 'reject') {
      if (!online()) return
      void sendWithoutAck('request-response', { requesterUserId: userId, action })
    },
    reactToMessage(userId: string, messageId: string, reaction: SocialMessageReaction['reaction']) {
      if (!online()) return
      void sendWithoutAck('message-reaction', { targetUserId: userId, messageId, reaction })
    },
    markNotificationsRead() {
      if (!online()) return
      void sendWithoutAck('notifications-read')
    },
    updateNotificationPreferences(preferences: SocialNotificationPreferences) {
      const deviceChanged = preferences.deviceEnabled !== state.notificationPreferences.deviceEnabled
      update({ notificationPreferences: preferences })
      if (online()) {
        void sendWithoutAck('notification-preferences', {
          messagesEnabled: preferences.messagesEnabled,
          reactionsEnabled: preferences.reactionsEnabled,
        })
      }
      if (deviceChanged) void setDeviceNotifications(preferences.deviceEnabled)
    },
    // On the PC this is the same switch as Settings › Notifications: Windows
    // notifications are shown by the main process, not by this renderer.
    requestDeviceNotifications() {
      void setDeviceNotifications(!state.notificationPreferences.deviceEnabled)
    },
    toggleMute(userId: string) {
      if (!online()) return
      void sendWithoutAck('mute', { targetUserId: userId })
    },
    reportUser(userId: string, reason: string, detail = '', messageId = '') {
      if (!online()) return
      void sendWithoutAck('report', {
        targetUserId: userId,
        reason: reason.trim().slice(0, SOCIAL_REPORT_REASON_MAX_LENGTH),
        detail: detail.trim().slice(0, SOCIAL_REPORT_DETAIL_MAX_LENGTH),
        messageId: messageId || '',
      })
    },
    clearFeedback() {
      if (state.feedback) update({ feedback: undefined })
    },
    toggleListeningWith(userId: string) {
      update({ selectedUserId: userId })
      if (state.listeningWithUserId === userId) expectRoomExit(state.activeRoomId)
      void sendWithoutAck('listening', { targetUserId: userId })
    },
    joinRoom(roomId: string) {
      if (!online()) return
      if (state.activeRoomId === roomId) expectRoomExit(roomId)
      void send('room-membership', { roomId }).then((result) => {
        if (!result.ok) expectedRoomExit = { roomId: '', until: 0 }
        update({ feedback: roomMembershipFeedback(result, newId()) })
      })
    },
    async sendRoomMessage(roomId: string, text: string) {
      const message = text.trim().slice(0, SOCIAL_ROOM_MESSAGE_MAX_LENGTH)
      if (!message || !online()) return false
      const result = await send('room-message', { roomId, text: message, clientMessageId: newId() })
      if (result.code === 'timeout') notify('error', SOCIAL_TEXT.roomMessageTimeout)
      else if (!result.ok && result.code !== 'offline') notify('error', socialErrorText(result.code))
      return result.ok === true
    },
    sendRoomReaction(roomId: string, reaction: SocialRoomReaction['reaction']) {
      if (!online()) return
      void send('room-reaction', { roomId, reaction }).then((result) => {
        if (!result.ok && result.code !== 'offline') notify('error', socialErrorText(result.code))
      })
    },
    createRoom() {
      // Closing your own room is an expected exit, not "the room was closed".
      const ownedRoom = state.rooms.find((room) => room.viewerRole === 'owner')
      if (ownedRoom) expectRoomExit(ownedRoom.id)
      void sendWithoutAck('create-room')
    },
    updatePrivacy(privacy: SocialPrivacy) {
      update({ privacy })
      void sendWithoutAck('privacy', { ...privacy })
    },
    blockUser(userId: string) {
      void sendWithoutAck('block', { targetUserId: userId })
    },
    reconnectSocial() {
      update({ connectionStatus: 'connecting' })
      void send('reconnect')
    },
    signIn() {
      notify('info', DESKTOP_TEXT.signInStarted)
      void send('sign-in').then((result) => {
        notify(result.ok ? 'success' : 'error', result.ok ? DESKTOP_TEXT.signedIn : DESKTOP_TEXT.signInFailed)
      })
    },
    signOut() {
      void send('sign-out').then((result) => {
        notify(result.ok ? 'info' : 'error', result.ok ? DESKTOP_TEXT.signedOut : DESKTOP_TEXT.signOutFailed)
      })
    },
  }

  async function setDeviceNotifications(enabled: boolean) {
    const result = await send('device-notifications', { enabled })
    if (!result.ok) {
      notify('error', socialErrorText(result.code))
      return
    }
    const deviceEnabled = result.enabled === true
    update({ notificationPreferences: { ...state.notificationPreferences, deviceEnabled } })
    if (result.supported === false) notify('info', DESKTOP_TEXT.deviceNotificationsUnsupported)
    else notify(deviceEnabled ? 'success' : 'info', deviceEnabled ? SOCIAL_TEXT.deviceNotificationsOn : DESKTOP_TEXT.deviceNotificationsOff)
  }

  // Subscribes to the main process; returns the matching cleanup so React
  // StrictMode's mount/unmount/mount cycle leaves exactly one set of listeners.
  function start() {
    let disposed = false
    const stopState = bridge.onState((incoming) => applyIncoming(incoming))
    const stopEvents = bridge.onEvent((event) => handleEvent(event))
    const stopVisibility = bridge.onVisibility((visible) => setVisible(visible))
    void bridge.getState()
      .then((incoming) => {
        if (!disposed && !receivedState) applyIncoming(incoming)
      })
      .catch(() => {
        if (!disposed && !receivedState) update({ connectionStatus: 'offline' })
      })
    return () => {
      disposed = true
      stopState()
      stopEvents()
      stopVisibility()
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    actions,
    // Exposed for tests.
    applyIncoming,
    handleEvent,
    setVisible,
  }
}

export type DesktopSocialStore = ReturnType<typeof createDesktopSocialStore>
