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
  title: string
  memberCount: number
  cover: number
  isLive: boolean
  memberInitials: string[]
}

export type SocialMessage = {
  id: string
  senderId: string
  text: string
  sentAt: number
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
  selectedUserId: string
  listeningWithUserId?: string
  activeRoomId?: string
}

export type SocialActions = {
  selectUser: (userId: string) => void
  reactToUser: (userId: string, reaction?: string) => void
  sendMessage: (userId: string, text: string) => void
  markConversationRead: (userId: string) => void
  toggleListeningWith: (userId: string) => void
  createRoom: () => void
  updatePrivacy: (privacy: SocialPrivacy) => void
  blockUser: (userId: string) => void
  reconnectSocial: () => void
}
