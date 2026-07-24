import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { ensureSocialAccessToken, invalidateSocialAccessToken } from '../social/auth'
import type { SocialActions, SocialPrivacy, SocialState, SocialTrack, SocialUser } from '../social/types'
import { ritimPairingToken, ritimRoom, ritimSyncUrl } from './usePlayerSync'

type Options = {
  displayName?: string
  avatarUrl?: string
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

export function stableSocialAccountId(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ritim-${(hash >>> 0).toString(36)}`
}

function socialDeviceId(isCompanion: boolean) {
  const key = isCompanion ? 'ritim-social-phone-id' : 'ritim-social-web-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const value = `${isCompanion ? 'phone' : 'web'}-${crypto.randomUUID()}`
  localStorage.setItem(key, value)
  return value
}

function defaultSocialUrl() {
  try {
    const url = new URL(ritimSyncUrl)
    url.port = '8790'
    return url.origin
  } catch {
    return `${window.location.protocol}//${window.location.hostname}:8790`
  }
}

export function normalizeSocialUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ritim Social adresi HTTP veya HTTPS olmalıdır.')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Ritim Social adresi kullanıcı bilgisi, sorgu veya fragment içeremez.')
  }
  return url.origin
}

function configuredSocialUrl() {
  const configured = String(import.meta.env.VITE_SOCIAL_URL || '').trim()
  try {
    return normalizeSocialUrl(configured || defaultSocialUrl())
  } catch {
    return normalizeSocialUrl(defaultSocialUrl())
  }
}

const socialUrl = configuredSocialUrl()
const socialSocket = io(socialUrl, {
  autoConnect: false,
  timeout: 3000,
  reconnectionDelay: 900,
})

export function useSocial({ displayName, avatarUrl, currentTrack, isCompanion }: Options): { state: SocialState; actions: SocialActions } {
  const accountId = useMemo(() => stableSocialAccountId(ritimPairingToken || ritimRoom), [])
  const deviceId = useMemo(() => socialDeviceId(isCompanion), [isCompanion])
  const deviceRole = isCompanion ? 'companion' : 'desktop'
  const resolvedName = displayName?.trim() || (isCompanion ? 'Ritim Telefon' : 'Ritim Web')
  const [connectionStatus, setConnectionStatus] = useState<SocialState['connectionStatus']>(() => socialSocket.connected ? 'online' : 'connecting')

  const localProfile = useMemo<SocialUser>(() => ({
    id: accountId,
    displayName: resolvedName,
    handle: profileHandle(resolvedName, isCompanion),
    initials: profileInitials(resolvedName),
    avatarUrl,
    avatarTone: isCompanion ? 3 : 5,
    presence: 'online',
    currentTrack,
    reactionCount: 0,
  }), [accountId, avatarUrl, currentTrack, isCompanion, resolvedName])

  const [snapshot, setSnapshot] = useState<SocialSnapshot>(() => ({
    currentUser: localProfile,
    privacy: {
      profileVisibility: 'everyone',
      listeningVisibility: 'everyone',
    },
    currentDeviceCount: 1,
    companionConnected: isCompanion,
    users: [],
    rooms: [],
    conversations: {},
    selectedUserId: '',
  }))
  const selectedUserIdRef = useRef('')
  selectedUserIdRef.current = snapshot.selectedUserId
  const profileRef = useRef(localProfile)
  profileRef.current = localProfile
  const connectSocialRef = useRef<() => void>(() => {})

  const joinSocialAccount = useCallback(() => {
    socialSocket.emit('social:join', {
      accountId,
      deviceId,
      deviceRole,
      profile: profileRef.current,
    })
  }, [accountId, deviceId, deviceRole])

  useEffect(() => {
    let disposed = false
    let authRetryUsed = false
    const connectSocial = async () => {
      setConnectionStatus('connecting')
      const accessToken = await ensureSocialAccessToken({
        socialUrl,
        syncUrl: ritimSyncUrl,
        pairingToken: ritimPairingToken,
        isCompanion,
      }).catch(() => '')
      if (disposed) return
      socialSocket.auth = accessToken ? { accessToken } : {}
      if (socialSocket.connected) socialSocket.disconnect()
      socialSocket.connect()
    }
    connectSocialRef.current = () => void connectSocial()
    const onConnect = () => {
      setConnectionStatus('online')
      joinSocialAccount()
    }
    const onDisconnect = () => {
      setConnectionStatus('offline')
      setSnapshot((previous) => ({
        ...previous,
        users: previous.users.map((user) => ({ ...user, presence: 'offline' })),
      }))
    }
    const onConnectError = (error: Error) => {
      setConnectionStatus('offline')
      if (!authRetryUsed && /oturumu geçersiz/i.test(error.message)) {
        authRetryUsed = true
        void invalidateSocialAccessToken().then(connectSocial)
      }
    }
    const onReconnectAttempt = () => setConnectionStatus('connecting')
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

    socialSocket.on('connect', onConnect)
    socialSocket.on('disconnect', onDisconnect)
    socialSocket.on('connect_error', onConnectError)
    socialSocket.on('social:state', onSocialState)
    socialSocket.io.on('reconnect_attempt', onReconnectAttempt)
    void connectSocial()

    return () => {
      disposed = true
      connectSocialRef.current = () => {}
      socialSocket.off('connect', onConnect)
      socialSocket.off('disconnect', onDisconnect)
      socialSocket.off('connect_error', onConnectError)
      socialSocket.off('social:state', onSocialState)
      socialSocket.io.off('reconnect_attempt', onReconnectAttempt)
      socialSocket.disconnect()
    }
  }, [isCompanion, joinSocialAccount])

  useEffect(() => {
    if (socialSocket.connected) socialSocket.emit('social:profile', { profile: localProfile })
  }, [localProfile])

  const selectUser = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
  }, [])

  const reactToUser = useCallback((userId: string, reaction = '♥') => {
    socialSocket.emit('social:reaction', { targetUserId: userId, reaction })
  }, [])

  const sendMessage = useCallback((userId: string, text: string) => {
    const cleanText = text.trim().slice(0, 500)
    if (!cleanText) return
    socialSocket.emit('social:message', { targetUserId: userId, text: cleanText })
  }, [])

  const toggleListeningWith = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
    socialSocket.emit('social:listening', { targetUserId: userId })
  }, [])

  const createRoom = useCallback(() => {
    socialSocket.emit('social:create-room', {
      title: currentTrack.title || `${resolvedName} dinliyor`,
      cover: currentTrack.cover,
    })
  }, [currentTrack.cover, currentTrack.title, resolvedName])

  const updatePrivacy = useCallback((privacy: SocialPrivacy) => {
    setSnapshot((current) => ({ ...current, privacy }))
    socialSocket.emit('social:privacy', privacy)
  }, [])

  const blockUser = useCallback((userId: string) => {
    socialSocket.emit('social:block', { targetUserId: userId })
  }, [])

  const reconnectSocial = useCallback(() => {
    setConnectionStatus('connecting')
    connectSocialRef.current()
  }, [])

  return {
    state: {
      ...snapshot,
      connectionStatus,
    },
    actions: {
      selectUser,
      reactToUser,
      sendMessage,
      toggleListeningWith,
      createRoom,
      updatePrivacy,
      blockUser,
      reconnectSocial,
    },
  }
}
