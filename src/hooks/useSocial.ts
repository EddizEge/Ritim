import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SocialActions, SocialState, SocialTrack, SocialUser } from '../social/types'
import { ritimRoom, ritimSocket } from './usePlayerSync'

type Options = {
  displayName?: string
  currentTrack: SocialTrack
  isCompanion: boolean
}

type SocialSnapshot = Omit<SocialState, 'connectionStatus'>

function profileInitials(displayName: string) {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('tr'))
    .join('')
  return initials || 'R'
}

function profileHandle(displayName: string, isCompanion: boolean) {
  const normalized = displayName
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
  return `@${normalized || (isCompanion ? 'telefon' : 'ritimpc')}`
}

function socialDeviceId(isCompanion: boolean) {
  const key = isCompanion ? 'ritim-social-phone-id' : 'ritim-social-web-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const value = `${isCompanion ? 'phone' : 'web'}-${crypto.randomUUID()}`
  localStorage.setItem(key, value)
  return value
}

export function useSocial({ displayName, currentTrack, isCompanion }: Options): { state: SocialState; actions: SocialActions } {
  const deviceId = useMemo(() => socialDeviceId(isCompanion), [isCompanion])
  const resolvedName = displayName?.trim() || (isCompanion ? 'Ritim Telefon' : 'Ritim Web')
  const [connectionStatus, setConnectionStatus] = useState<SocialState['connectionStatus']>(() => ritimSocket.connected ? 'online' : 'connecting')
  const [snapshot, setSnapshot] = useState<SocialSnapshot>(() => ({
    currentUser: {
      id: deviceId,
      displayName: resolvedName,
      handle: profileHandle(resolvedName, isCompanion),
      initials: profileInitials(resolvedName),
      avatarTone: isCompanion ? 3 : 5,
      presence: 'online',
      currentTrack,
      reactionCount: 0,
    },
    users: [],
    rooms: [],
    conversations: {},
    selectedUserId: '',
  }))
  const selectedUserIdRef = useRef('')
  selectedUserIdRef.current = snapshot.selectedUserId

  const currentUser = useMemo<SocialUser>(() => ({
    id: deviceId,
    displayName: resolvedName,
    handle: profileHandle(resolvedName, isCompanion),
    initials: profileInitials(resolvedName),
    avatarTone: isCompanion ? 3 : 5,
    presence: 'online',
    currentTrack,
    reactionCount: snapshot.currentUser.reactionCount,
    lastReaction: snapshot.currentUser.lastReaction,
  }), [currentTrack, deviceId, isCompanion, resolvedName, snapshot.currentUser.lastReaction, snapshot.currentUser.reactionCount])

  useEffect(() => {
    const publishProfile = () => {
      if (!ritimSocket.connected) return
      ritimSocket.emit('social:profile', { room: ritimRoom, profile: currentUser })
    }
    const onConnect = () => {
      setConnectionStatus('online')
      queueMicrotask(publishProfile)
    }
    const onDisconnect = () => setConnectionStatus('offline')
    const onRoomStatus = () => publishProfile()
    const onSocialState = (next: SocialSnapshot) => {
      setConnectionStatus('online')
      setSnapshot((previous) => {
        const selected = selectedUserIdRef.current
        const selectedStillExists = next.users.some((user) => user.id === selected)
        return {
          ...next,
          selectedUserId: selectedStillExists ? selected : next.selectedUserId,
        }
      })
    }

    ritimSocket.on('connect', onConnect)
    ritimSocket.on('disconnect', onDisconnect)
    ritimSocket.on('room:status', onRoomStatus)
    ritimSocket.on('social:state', onSocialState)
    publishProfile()

    return () => {
      ritimSocket.off('connect', onConnect)
      ritimSocket.off('disconnect', onDisconnect)
      ritimSocket.off('room:status', onRoomStatus)
      ritimSocket.off('social:state', onSocialState)
    }
  }, [currentUser])

  const selectUser = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
  }, [])

  const reactToUser = useCallback((userId: string, reaction = '♥') => {
    ritimSocket.emit('social:reaction', { room: ritimRoom, targetUserId: userId, reaction })
  }, [])

  const sendMessage = useCallback((userId: string, text: string) => {
    const cleanText = text.trim().slice(0, 500)
    if (!cleanText) return
    ritimSocket.emit('social:message', { room: ritimRoom, targetUserId: userId, text: cleanText })
  }, [])

  const toggleListeningWith = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
    ritimSocket.emit('social:listening', { room: ritimRoom, targetUserId: userId })
  }, [])

  const createRoom = useCallback(() => {
    ritimSocket.emit('social:create-room', {
      room: ritimRoom,
      title: currentTrack.title || `${resolvedName} dinliyor`,
      cover: currentTrack.cover,
    })
  }, [currentTrack.cover, currentTrack.title, resolvedName])

  return {
    state: {
      ...snapshot,
      connectionStatus,
      currentUser,
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
