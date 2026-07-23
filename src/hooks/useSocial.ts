import { useCallback, useMemo, useState } from 'react'
import { socialPreviewMessages, socialPreviewRooms, socialPreviewUsers } from '../social/demo'
import type { SocialActions, SocialState, SocialTrack, SocialUser } from '../social/types'

type Options = {
  displayName?: string
  currentTrack: SocialTrack
}

function profileInitials(displayName: string) {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('tr'))
    .join('')
  return initials || 'R'
}

function profileHandle(displayName: string) {
  const normalized = displayName
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
  return `@${normalized || 'ritim'}`
}

export function useSocial({ displayName = 'Ritim kullanıcısı', currentTrack }: Options): { state: SocialState; actions: SocialActions } {
  const [users, setUsers] = useState(() => socialPreviewUsers)
  const [rooms, setRooms] = useState(() => socialPreviewRooms)
  const [conversations, setConversations] = useState(() => socialPreviewMessages)
  const [selectedUserId, setSelectedUserId] = useState(socialPreviewUsers[0]?.id || '')
  const [listeningWithUserId, setListeningWithUserId] = useState<string>()
  const [activeRoomId, setActiveRoomId] = useState<string>()

  const currentUser = useMemo<SocialUser>(() => ({
    id: 'current-user',
    displayName,
    handle: profileHandle(displayName),
    initials: profileInitials(displayName),
    avatarTone: 5,
    presence: 'online',
    currentTrack,
    reactionCount: 0,
  }), [currentTrack, displayName])

  const selectUser = useCallback((userId: string) => setSelectedUserId(userId), [])

  const reactToUser = useCallback((userId: string, reaction = '♥') => {
    setUsers((current) => current.map((user) => (
      user.id === userId
        ? { ...user, reactionCount: user.reactionCount + 1, lastReaction: reaction }
        : user
    )))
  }, [])

  const sendMessage = useCallback((userId: string, text: string) => {
    const cleanText = text.trim().slice(0, 500)
    if (!cleanText) return
    const message = {
      id: `message-${Date.now()}`,
      senderId: 'current-user',
      text: cleanText,
      sentAt: Date.now(),
    }
    setConversations((current) => ({
      ...current,
      [userId]: [...(current[userId] || []), message],
    }))
  }, [])

  const toggleListeningWith = useCallback((userId: string) => {
    setSelectedUserId(userId)
    setListeningWithUserId((current) => current === userId ? undefined : userId)
  }, [])

  const createRoom = useCallback(() => {
    setRooms((current) => {
      const existing = current.find((room) => room.id === 'room-current-user')
      if (existing) return current
      return [{
        id: 'room-current-user',
        title: currentTrack.title || 'Yeni dinleme odası',
        memberCount: 1,
        cover: currentTrack.cover,
        isLive: true,
        memberInitials: [profileInitials(displayName)],
      }, ...current]
    })
    setActiveRoomId('room-current-user')
  }, [currentTrack.cover, currentTrack.title, displayName])

  return {
    state: {
      connectionStatus: 'preview',
      currentUser,
      users,
      rooms,
      conversations,
      selectedUserId,
      listeningWithUserId,
      activeRoomId,
    },
    actions: {
      selectUser,
      reactToUser,
      sendMessage,
      toggleListeningWith,
      createRoom,
    },
  }
}
