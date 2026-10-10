export type SocialConnectionStatus = 'preview' | 'connecting' | 'online' | 'offline'
export type SocialVisibility = 'everyone' | 'contacts' | 'hidden'

export type SocialPrivacy = {
  profileVisibility: SocialVisibility
  listeningVisibility: SocialVisibility
}

export type SocialTrack = {
  id: string
  videoId?: string
  title: string
  artist: string
  duration: number
  position: number
  cover: number
  thumbnailUrl?: string
  isPlaying: boolean
}

export type SocialUser = {
  id: string
  displayName: string
  handle: string
  initials: string
  avatarUrl?: string
  avatarTone: number
  presence: 'online' | 'away' | 'offline'
  currentTrack?: SocialTrack
  reactionCount: number
  lastReaction?: string
}

export type SocialRoom = {
  id: string
  ownerId: string
  title: string
  memberCount: number
  maxMembers: number
  cover: number
  isLive: boolean
  ownerDesktopOnline: boolean
  lifecycle: 'waiting' | 'live' | 'owner_offline'
  viewerPlaybackStatus: 'idle' | 'ready' | 'unavailable'
  viewerPlaybackError?: string
  syncSummary?: SocialRoomSyncSummary
  memberInitials: string[]
  viewerRole?: 'owner' | 'listener'
  playback?: SocialRoomPlayback
}

export type SocialRoomSyncSummary = {
  status: 'waiting' | 'synced' | 'corrected' | 'unavailable'
  roundTripMs?: number
  driftMs?: number
  measuredAt?: number
}

export type SocialRoomPlayback = {
  roomId: string
  ownerId: string
  videoId: string
  playbackPositionMs: number
  playbackState: 'playing' | 'paused'
  playbackRevision: number
  serverTimeMs: number
}

export type SocialMessage = {
  id: string
  senderId: string
  text: string
  sentAt: number
  reactions: SocialMessageReaction[]
}

export type SocialMessageReaction = {
  actorId: string
  reaction: '♥' | '🔥' | '😂' | '👍'
}

export type SocialRoomMessage = {
  id: string
  roomId: string
  senderId: string
  text: string
  sentAt: number
}

export type SocialRoomReaction = {
  id: string
  roomId: string
  actorId: string
  reaction: '♥' | '🔥' | '👏' | '🎵'
  createdAt: number
  expiresAt: number
}

export type SocialMessageRequest = {
  userId: string
  direction: 'incoming' | 'outgoing'
  preview: string
  sentAt: number
}

// `profile_reaction` (someone left an emoji on your profile) carries the
// emoji in `body` and has no `messageId`. Kinds this client does not know are
// skipped by the interface and by system notifications.
export type SocialNotificationKind = 'message_request' | 'message' | 'reaction' | 'profile_reaction'

export type SocialNotification = {
  id: string
  kind: SocialNotificationKind
  actorId?: string
  messageId?: string
  body: string
  createdAt: number
  read: boolean
}

export type SocialNotificationPreferences = {
  messagesEnabled: boolean
  reactionsEnabled: boolean
  deviceEnabled: boolean
}

export type SocialReportSummary = {
  total: number
  recent: Array<{
    targetUserId: string
    displayName: string
    reason: string
    createdAt: number
    status: 'received'
  }>
}

export type SocialFeedback = {
  id: string
  tone: 'success' | 'info' | 'error'
  text: string
}

export type SocialAccountDevice = {
  id: string
  role: 'desktop' | 'companion'
  name: string
  lastSeenAt?: string
  createdAt: string
}

export type SocialAccountSummary = {
  authenticated: boolean
  user?: Pick<SocialUser, 'id' | 'displayName' | 'handle' | 'initials' | 'avatarUrl' | 'avatarTone'>
  currentDeviceId: string
  devices: SocialAccountDevice[]
  limited?: boolean
  warning?: string
}

// Only the Electron Social view fills this: the PC signs in to Ritim Social
// itself, while phones join through the PC's companion ticket.
export type SocialAuthenticationSummary = {
  configured: boolean
  required: boolean
  authenticated: boolean
  user?: Pick<SocialUser, 'id' | 'displayName' | 'handle' | 'initials' | 'avatarUrl' | 'avatarTone'>
}

export type SocialState = {
  connectionStatus: SocialConnectionStatus
  authentication?: SocialAuthenticationSummary
  currentUser: SocialUser
  privacy: SocialPrivacy
  currentDeviceCount: number
  companionConnected: boolean
  users: SocialUser[]
  rooms: SocialRoom[]
  roomMessages: Record<string, SocialRoomMessage[]>
  roomReactions: Record<string, SocialRoomReaction[]>
  conversations: Record<string, SocialMessage[]>
  unreadCounts: Record<string, number>
  messageRequests: SocialMessageRequest[]
  notifications: SocialNotification[]
  notificationPreferences: SocialNotificationPreferences
  mutedUserIds: string[]
  mutedUsers: SocialUser[]
  blockedUsers: SocialUser[]
  reportSummary: SocialReportSummary
  feedback?: SocialFeedback
  selectedUserId: string
  listeningWithUserId?: string
  activeRoomId?: string
  // Last moment this device was known to be connected to Ritim Social.
  lastOnlineAt?: number
}

// Acknowledgement of a direct message; `code` explains a failure
// ('offline', 'timeout', or a gateway code such as 'rate_limited').
export type SocialSendResult = {
  ok: boolean
  code?: string
  duplicate?: boolean
}

export type SocialSettingsSection = 'social' | 'notifications'

export type SocialActions = {
  selectUser: (userId: string) => void
  reactToUser: (userId: string, reaction?: string) => void
  // Retrying passes the same clientMessageId; the gateway drops duplicates.
  sendMessage: (userId: string, text: string, clientMessageId?: string) => Promise<SocialSendResult>
  markConversationRead: (userId: string) => void
  respondToMessageRequest: (userId: string, action: 'accept' | 'reject') => void
  reactToMessage: (userId: string, messageId: string, reaction: SocialMessageReaction['reaction']) => void
  markNotificationsRead: () => void
  updateNotificationPreferences: (preferences: SocialNotificationPreferences) => void
  requestDeviceNotifications: () => void
  toggleMute: (userId: string) => void
  reportUser: (userId: string, reason: string, detail?: string, messageId?: string) => void
  clearFeedback: () => void
  toggleListeningWith: (userId: string) => void
  joinRoom: (roomId: string) => void
  sendRoomMessage: (roomId: string, text: string) => Promise<boolean>
  sendRoomReaction: (roomId: string, reaction: SocialRoomReaction['reaction']) => void
  createRoom: () => void
  updatePrivacy: (privacy: SocialPrivacy) => void
  blockUser: (userId: string) => void
  reconnectSocial: () => void
  signIn?: () => void
  signOut?: () => void
  // PC only: opens the Settings window on the given section.
  openSettings?: (section: SocialSettingsSection) => void
}
