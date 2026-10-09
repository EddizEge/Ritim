import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { io } from 'socket.io-client'
import type { MobilePairingConfig } from '../mobileConfig'
import { ensureSocialAccessToken, invalidateSocialAccessToken } from '../social/auth'
import { createSocialProfilePublisher } from '../social/profilePublishPolicy'
import {
  EXPECTED_ROOM_EXIT_MS,
  SOCIAL_ACK_TIMEOUT_MS,
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
  type SocialAckResult,
  type SocialSnapshot,
} from '../social/socialShared'
import type {
  SocialActions,
  SocialMessageReaction,
  SocialNotification,
  SocialNotificationPreferences,
  SocialPrivacy,
  SocialRoomReaction,
  SocialState,
  SocialTrack,
  SocialUser,
} from '../social/types'

type Options = {
  displayName?: string
  avatarUrl?: string
  currentTrack: SocialTrack
  isCompanion: boolean
  pairing: MobilePairingConfig
}

const PUBLIC_SOCIAL_URL = 'https://social.edizegemercan.com.tr'
const DELIVERED_NOTIFICATION_IDS_KEY = 'ritim-social-delivered-notifications-v1'
const DEVICE_NOTIFICATIONS_KEY = 'ritim-social-device-notifications-v1'

function deviceNotificationsEnabled() {
  return localStorage.getItem(DEVICE_NOTIFICATIONS_KEY) === 'enabled'
}

function saveDeviceNotifications(enabled: boolean) {
  localStorage.setItem(DEVICE_NOTIFICATIONS_KEY, enabled ? 'enabled' : 'disabled')
}

function deliveredNotificationIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DELIVERED_NOTIFICATION_IDS_KEY) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.slice(-100) : [])
  } catch {
    return new Set<string>()
  }
}

function notificationNumber(id: string) {
  let value = 0
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0
  }
  return Math.max(1, Math.abs(value))
}

function notificationTitle(notification: SocialNotification, actorName: string) {
  if (notification.kind === 'reaction') return `${actorName} mesajına tepki verdi`
  if (notification.kind === 'message_request') return `${actorName} mesaj isteği gönderdi`
  return `${actorName} sana yazdı`
}

async function deliverDeviceNotification(notification: SocialNotification, actorName: string) {
  const title = notificationTitle(notification, actorName)
  if (Capacitor.isNativePlatform()) {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const permission = await LocalNotifications.checkPermissions()
    if (permission.display !== 'granted') return false
    await LocalNotifications.createChannel({
      id: 'ritim-social',
      name: 'Ritim Sosyal',
      description: 'Mesajlar ve sosyal tepkiler',
      importance: 4,
    }).catch(() => {})
    await LocalNotifications.schedule({
      notifications: [{
        id: notificationNumber(notification.id),
        title,
        body: notification.kind === 'reaction' ? `${notification.body} tepkisi` : notification.body,
        channelId: 'ritim-social',
        extra: { socialNotificationId: notification.id },
      }],
    })
    return true
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return false
  new Notification(title, {
    body: notification.kind === 'reaction' ? `${notification.body} tepkisi` : notification.body,
    tag: `ritim-social-${notification.id}`,
  })
  return true
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

function socialDeviceId(isCompanion: boolean, accountId: string) {
  const key = `${isCompanion ? 'ritim-social-phone-id' : 'ritim-social-web-id'}:${accountId}`
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const value = `${isCompanion ? 'phone' : 'web'}-${crypto.randomUUID()}`
  localStorage.setItem(key, value)
  return value
}

function defaultSocialUrl(syncUrl: string) {
  if (import.meta.env.PROD) return PUBLIC_SOCIAL_URL
  try {
    const url = new URL(syncUrl)
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

export function configuredSocialUrl(syncUrl: string) {
  const configured = String(import.meta.env.VITE_SOCIAL_URL || '').trim()
  try {
    return normalizeSocialUrl(configured || defaultSocialUrl(syncUrl))
  } catch {
    return normalizeSocialUrl(defaultSocialUrl(syncUrl))
  }
}

export function useSocial({ displayName, avatarUrl, currentTrack, isCompanion, pairing }: Options): { state: SocialState; actions: SocialActions } {
  const socialUrl = useMemo(() => configuredSocialUrl(pairing.syncUrl), [pairing.syncUrl])
  const socket = useMemo(() => io(socialUrl, {
    autoConnect: false,
    timeout: 3000,
    reconnectionDelay: 900,
  }), [socialUrl])
  const accountId = pairing.installationId || stableSocialAccountId(pairing.token || pairing.room)
  const deviceId = useMemo(() => socialDeviceId(isCompanion, accountId), [accountId, isCompanion])
  const deviceRole = isCompanion ? 'companion' : 'desktop'
  const resolvedName = displayName?.trim() || (isCompanion ? 'Ritim Telefon' : 'Ritim Web')
  const [connectionStatus, setConnectionStatus] = useState<SocialState['connectionStatus']>(() => socket.connected ? 'online' : 'connecting')

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
    roomMessages: {},
    roomReactions: {},
    conversations: {},
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: {
      messagesEnabled: true,
      reactionsEnabled: true,
      deviceEnabled: deviceNotificationsEnabled(),
    },
    mutedUserIds: [],
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
    selectedUserId: '',
  }))
  const selectedUserIdRef = useRef('')
  selectedUserIdRef.current = snapshot.selectedUserId
  const profileRef = useRef(localProfile)
  profileRef.current = localProfile
  const profilePublisherRef = useRef<ReturnType<typeof createSocialProfilePublisher> | null>(null)
  if (!profilePublisherRef.current) profilePublisherRef.current = createSocialProfilePublisher()
  const profilePublisher = profilePublisherRef.current
  const notificationPreferencesRef = useRef(snapshot.notificationPreferences)
  notificationPreferencesRef.current = snapshot.notificationPreferences
  const deliveredNotificationsRef = useRef<Set<string> | null>(null)
  if (!deliveredNotificationsRef.current) deliveredNotificationsRef.current = deliveredNotificationIds()
  const deliveredNotificationSet = deliveredNotificationsRef.current
  const connectSocialRef = useRef<() => void>(() => {})
  const playbackPublishRef = useRef({ roomId: '', revision: 0, signature: '' })
  const activeRoomIdRef = useRef(snapshot.activeRoomId)
  activeRoomIdRef.current = snapshot.activeRoomId
  const expectedRoomExitRef = useRef<ExpectedRoomExit>({ roomId: '', until: 0 })

  const joinSocialAccount = useCallback(() => {
    socket.emit('social:join', {
      accountId,
      deviceId,
      deviceRole,
      profile: profileRef.current,
    })
    profilePublisher.remember(profileRef.current)
  }, [accountId, deviceId, deviceRole, profilePublisher, socket])

  useEffect(() => {
    let disposed = false
    let authRetryUsed = false
    const connectSocial = async () => {
      setConnectionStatus('connecting')
      const accessToken = await ensureSocialAccessToken({
        socialUrl,
        syncUrl: pairing.syncUrl,
        pairingToken: pairing.token,
        isCompanion,
      }).catch(() => '')
      if (disposed) return
      socket.auth = accessToken ? { accessToken } : {}
      if (socket.connected) socket.disconnect()
      socket.connect()
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
        feedback: socialFeedback('info', SOCIAL_TEXT.disconnected),
        users: previous.users.map((user) => ({ ...user, presence: 'offline' })),
      }))
    }
    const onConnectError = (error: Error) => {
      setConnectionStatus('offline')
      if (!authRetryUsed && /oturumu geçersiz/i.test(error.message)) {
        authRetryUsed = true
        void invalidateSocialAccessToken().then(connectSocial).catch((authError) => {
          if ((authError as Error)?.name !== 'AbortError') console.warn('[Ritim] Sosyal oturum yenilenemedi:', authError)
        })
      }
    }
    const onReconnectAttempt = () => setConnectionStatus('connecting')
    const onSessionChanged = () => void connectSocial()
    const onSocialState = (next: SocialSnapshot) => {
      setConnectionStatus('online')
      setSnapshot((previous) => {
        const { snapshot: merged, resetExpectedRoomExit } = mergeIncomingSocialSnapshot(previous, next, {
          selectedUserId: selectedUserIdRef.current,
          expectedRoomExit: expectedRoomExitRef.current,
          deviceEnabled: notificationPreferencesRef.current.deviceEnabled,
          now: Date.now(),
        })
        if (resetExpectedRoomExit) expectedRoomExitRef.current = { roomId: '', until: 0 }
        return merged
      })
    }
    const onSocialError = (error: { code?: string; event?: string }) => {
      // Profil yenileme arka planda gerçekleşir; kullanıcı eylemi değildir.
      // Mesaj hataları da acknowledgement callback'i üzerinden daha doğru
      // biçimde ele alınır ve burada ikinci kez başarı/hata bildirimini ezmez.
      if (isAckHandledSocialError(error?.event)) return
      setSnapshot((previous) => ({
        ...previous,
        feedback: socialFeedback('error', socialErrorText(error?.code)),
      }))
    }
    const onReportSaved = () => {
      setSnapshot((previous) => ({
        ...previous,
        feedback: socialFeedback('success', SOCIAL_TEXT.reportSaved),
      }))
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('social:state', onSocialState)
    socket.on('social:error', onSocialError)
    socket.on('social:report-saved', onReportSaved)
    socket.io.on('reconnect_attempt', onReconnectAttempt)
    window.addEventListener('ritim:social-session-changed', onSessionChanged)
    void connectSocial()

    return () => {
      disposed = true
      connectSocialRef.current = () => {}
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('social:state', onSocialState)
      socket.off('social:error', onSocialError)
      socket.off('social:report-saved', onReportSaved)
      socket.io.off('reconnect_attempt', onReconnectAttempt)
      window.removeEventListener('ritim:social-session-changed', onSessionChanged)
      socket.disconnect()
    }
  }, [isCompanion, joinSocialAccount, pairing.syncUrl, pairing.token, socialUrl, socket])

  useEffect(() => {
    // currentTrack.position changes every second; see profilePublishPolicy.ts.
    if (!socket.connected || !profilePublisher.shouldPublish(localProfile)) return
    profilePublisher.remember(localProfile)
    socket.emit('social:profile', { profile: localProfile })
  }, [localProfile, profilePublisher, socket])

  const ownedRoom = snapshot.rooms.find((room) => room.viewerRole === 'owner')
  const ownedRoomId = ownedRoom?.id || ''
  const ownedRoomRevision = Number(ownedRoom?.playback?.playbackRevision) || 0
  useEffect(() => {
    if (isCompanion || !socket.connected || !ownedRoomId || !currentTrack.videoId) return
    const publishState = playbackPublishRef.current
    if (publishState.roomId !== ownedRoomId) {
      publishState.roomId = ownedRoomId
      publishState.revision = ownedRoomRevision
      publishState.signature = ''
    } else {
      publishState.revision = Math.max(publishState.revision, ownedRoomRevision)
    }
    const playbackPositionMs = Math.max(0, Math.round((Number(currentTrack.position) || 0) * 1000))
    const playbackState = currentTrack.isPlaying ? 'playing' : 'paused'
    const signature = JSON.stringify([currentTrack.videoId, playbackPositionMs, playbackState])
    if (signature === publishState.signature) return
    publishState.signature = signature
    const playbackRevision = ++publishState.revision
    socket.emit('social:room-playback:update', {
      roomId: ownedRoomId,
      videoId: currentTrack.videoId,
      playbackPositionMs,
      playbackState,
      playbackRevision,
    }, (result: { ok?: boolean; playback?: { playbackRevision?: number } } = {}) => {
      publishState.revision = Math.max(
        publishState.revision,
        Number(result.playback?.playbackRevision) || 0,
      )
      if (!result.ok) publishState.signature = ''
    })
  }, [currentTrack.isPlaying, currentTrack.position, currentTrack.videoId, isCompanion, ownedRoomId, ownedRoomRevision, socket])

  useEffect(() => {
    if (!snapshot.notificationPreferences.deviceEnabled || !document.hidden) return
    const pending = snapshot.notifications.filter((notification) => (
      !notification.read && !deliveredNotificationSet.has(notification.id)
    ))
    if (!pending.length) return
    void Promise.all(pending.map(async (notification) => {
      const actorName = snapshot.users.find((user) => user.id === notification.actorId)?.displayName || 'Bir Ritim kullanıcısı'
      const delivered = await deliverDeviceNotification(notification, actorName).catch(() => false)
      if (delivered) deliveredNotificationSet.add(notification.id)
    })).then(() => {
      localStorage.setItem(
        DELIVERED_NOTIFICATION_IDS_KEY,
        JSON.stringify([...deliveredNotificationSet].slice(-100)),
      )
    })
  }, [deliveredNotificationSet, snapshot.notificationPreferences.deviceEnabled, snapshot.notifications, snapshot.users])

  const selectUser = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
  }, [])

  const reactToUser = useCallback((userId: string, reaction = '♥') => {
    socket.emit('social:reaction', { targetUserId: userId, reaction })
  }, [socket])

  const sendMessage = useCallback((userId: string, text: string): Promise<boolean> => {
    const cleanText = text.trim().slice(0, SOCIAL_MESSAGE_MAX_LENGTH)
    if (!cleanText) return Promise.resolve(false)
    if (!socket.connected) {
      setSnapshot((current) => ({
        ...current,
        feedback: socialFeedback('error', SOCIAL_TEXT.messageOffline),
      }))
      return Promise.resolve(false)
    }
    const clientMessageId = crypto.randomUUID()
    return new Promise((resolve) => {
      let acknowledged = false
      const timeout = window.setTimeout(() => {
        if (acknowledged) return
        acknowledged = true
        setSnapshot((current) => ({
          ...current,
          feedback: socialFeedback('error', SOCIAL_TEXT.messageTimeout),
        }))
        resolve(false)
      }, SOCIAL_ACK_TIMEOUT_MS)
      socket.emit('social:message', {
        targetUserId: userId,
        text: cleanText,
        clientMessageId,
      }, (result: SocialAckResult = {}) => {
        if (acknowledged) return
        acknowledged = true
        window.clearTimeout(timeout)
        setSnapshot((current) => ({
          ...current,
          feedback: messageAckFeedback(result),
        }))
        resolve(Boolean(result.ok))
      })
    })
  }, [socket])

  const markConversationRead = useCallback((userId: string) => {
    if (!socket.connected) return
    socket.emit('social:read', { targetUserId: userId })
  }, [socket])

  const respondToMessageRequest = useCallback((userId: string, action: 'accept' | 'reject') => {
    if (!socket.connected) return
    socket.emit('social:request-response', { requesterUserId: userId, action })
  }, [socket])

  const reactToMessage = useCallback((
    userId: string,
    messageId: string,
    reaction: SocialMessageReaction['reaction'],
  ) => {
    if (!socket.connected) return
    socket.emit('social:message-reaction', { targetUserId: userId, messageId, reaction })
  }, [socket])

  const markNotificationsRead = useCallback(() => {
    if (!socket.connected) return
    socket.emit('social:notifications-read')
  }, [socket])

  const updateNotificationPreferences = useCallback((preferences: SocialNotificationPreferences) => {
    saveDeviceNotifications(preferences.deviceEnabled)
    setSnapshot((current) => ({ ...current, notificationPreferences: preferences }))
    if (socket.connected) socket.emit('social:notification-preferences', {
      messagesEnabled: preferences.messagesEnabled,
      reactionsEnabled: preferences.reactionsEnabled,
    })
  }, [socket])

  const requestDeviceNotifications = useCallback(() => {
    void (async () => {
      let granted = false
      if (Capacitor.isNativePlatform()) {
        const { LocalNotifications } = await import('@capacitor/local-notifications')
        const current = await LocalNotifications.checkPermissions()
        const permission = current.display === 'prompt'
          ? await LocalNotifications.requestPermissions()
          : current
        granted = permission.display === 'granted'
      } else if ('Notification' in window) {
        granted = (Notification.permission === 'granted'
          ? Notification.permission
          : await Notification.requestPermission()) === 'granted'
      }
      const preferences = {
        ...notificationPreferencesRef.current,
        deviceEnabled: granted,
      }
      saveDeviceNotifications(granted)
      setSnapshot((current) => ({ ...current, notificationPreferences: preferences }))
      setSnapshot((current) => ({
        ...current,
        feedback: socialFeedback(
          granted ? 'success' : 'info',
          granted ? SOCIAL_TEXT.deviceNotificationsOn : SOCIAL_TEXT.deviceNotificationsDenied,
        ),
      }))
    })()
  }, [])

  const toggleMute = useCallback((userId: string) => {
    if (!socket.connected) return
    socket.emit('social:mute', { targetUserId: userId })
  }, [socket])

  const reportUser = useCallback((userId: string, reason: string, detail = '', messageId = '') => {
    if (!socket.connected) return
    socket.emit('social:report', {
      targetUserId: userId,
      reason: reason.trim().slice(0, SOCIAL_REPORT_REASON_MAX_LENGTH),
      detail: detail.trim().slice(0, SOCIAL_REPORT_DETAIL_MAX_LENGTH),
      messageId,
    })
  }, [socket])

  const clearFeedback = useCallback(() => {
    setSnapshot((current) => ({ ...current, feedback: undefined }))
  }, [])

  const toggleListeningWith = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
    socket.emit('social:listening', { targetUserId: userId })
  }, [socket])

  const joinRoom = useCallback((roomId: string) => {
    if (!socket.connected) return
    if (activeRoomIdRef.current === roomId) {
      expectedRoomExitRef.current = { roomId, until: Date.now() + EXPECTED_ROOM_EXIT_MS }
    }
    socket.emit('social:room-membership', { roomId }, (result: SocialAckResult = {}) => {
      if (!result.ok) expectedRoomExitRef.current = { roomId: '', until: 0 }
      setSnapshot((current) => ({
        ...current,
        feedback: roomMembershipFeedback(result),
      }))
    })
  }, [socket])

  const sendRoomMessage = useCallback((roomId: string, text: string): Promise<boolean> => {
    const message = text.trim().slice(0, SOCIAL_ROOM_MESSAGE_MAX_LENGTH)
    if (!message || !socket.connected) return Promise.resolve(false)
    return new Promise((resolve) => {
      let acknowledged = false
      const timeout = window.setTimeout(() => {
        if (acknowledged) return
        acknowledged = true
        setSnapshot((current) => ({
          ...current,
          feedback: socialFeedback('error', SOCIAL_TEXT.roomMessageTimeout),
        }))
        resolve(false)
      }, SOCIAL_ACK_TIMEOUT_MS)
      socket.emit('social:room-message', {
        roomId,
        text: message,
        clientMessageId: crypto.randomUUID(),
      }, (result: SocialAckResult = {}) => {
        if (acknowledged) return
        acknowledged = true
        window.clearTimeout(timeout)
        if (!result.ok) {
          setSnapshot((current) => ({
            ...current,
            feedback: socialFeedback('error', socialErrorText(result.code)),
          }))
        }
        resolve(Boolean(result.ok))
      })
    })
  }, [socket])

  const sendRoomReaction = useCallback((roomId: string, reaction: SocialRoomReaction['reaction']) => {
    if (!socket.connected) return
    socket.emit('social:room-reaction', { roomId, reaction }, (result: SocialAckResult = {}) => {
      if (result.ok) return
      setSnapshot((current) => ({
        ...current,
        feedback: socialFeedback('error', socialErrorText(result.code)),
      }))
    })
  }, [socket])

  const createRoom = useCallback(() => {
    socket.emit('social:create-room', {
      title: currentTrack.title || `${resolvedName} dinliyor`,
      cover: currentTrack.cover,
    })
  }, [currentTrack.cover, currentTrack.title, resolvedName, socket])

  const updatePrivacy = useCallback((privacy: SocialPrivacy) => {
    setSnapshot((current) => ({ ...current, privacy }))
    socket.emit('social:privacy', privacy)
  }, [socket])

  const blockUser = useCallback((userId: string) => {
    socket.emit('social:block', { targetUserId: userId })
  }, [socket])

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
      markConversationRead,
      respondToMessageRequest,
      reactToMessage,
      markNotificationsRead,
      updateNotificationPreferences,
      requestDeviceNotifications,
      toggleMute,
      reportUser,
      clearFeedback,
      toggleListeningWith,
      joinRoom,
      sendRoomMessage,
      sendRoomReaction,
      createRoom,
      updatePrivacy,
      blockUser,
      reconnectSocial,
    },
  }
}
