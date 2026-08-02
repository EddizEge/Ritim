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
  memberInitials: string[]
  viewerRole?: 'owner' | 'listener'
  playback?: SocialRoomPlayback
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

export type SocialMessageRequest = {
  userId: string
  direction: 'incoming' | 'outgoing'
  preview: string
  sentAt: number
}

export type SocialNotification = {
  id: string
  kind: 'message_request' | 'message' | 'reaction'
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

export type SocialFeedback = {
  id: string
  tone: 'success' | 'info' | 'error'
  text: string
}

export type SocialState = {
  connectionStatus: SocialConnectionStatus
  currentUser: SocialUser
  privacy: SocialPrivacy
  currentDeviceCount: number
  companionConnected: boolean
  users: SocialUser[]
  rooms: SocialRoom[]
  conversations: Record<string, SocialMessage[]>
  unreadCounts: Record<string, number>
  messageRequests: SocialMessageRequest[]
  notifications: SocialNotification[]
  notificationPreferences: SocialNotificationPreferences
  mutedUserIds: string[]
  blockedUsers: SocialUser[]
  feedback?: SocialFeedback
  selectedUserId: string
  listeningWithUserId?: string
  activeRoomId?: string
}

export type SocialActions = {
  selectUser: (userId: string) => void
  reactToUser: (userId: string, reaction?: string) => void
  sendMessage: (userId: string, text: string) => Promise<boolean>
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
  createRoom: () => void
  updatePrivacy: (privacy: SocialPrivacy) => void
  blockUser: (userId: string) => void
  reconnectSocial: () => void
}
