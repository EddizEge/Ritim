import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { io } from 'socket.io-client'
import { ensureSocialAccessToken, invalidateSocialAccessToken } from '../social/auth'
import type {
  SocialActions,
  SocialMessageReaction,
  SocialNotification,
  SocialNotificationPreferences,
  SocialPrivacy,
  SocialState,
  SocialTrack,
  SocialUser,
} from '../social/types'
import { ritimPairingToken, ritimRoom, ritimSyncUrl } from './usePlayerSync'

type Options = {
  displayName?: string
  avatarUrl?: string
  currentTrack: SocialTrack
  isCompanion: boolean
}

type SocialSnapshot = Omit<SocialState, 'connectionStatus'>

const PUBLIC_SOCIAL_URL = 'https://social.edizegemercan.com.tr'
const DELIVERED_NOTIFICATION_IDS_KEY = 'ritim-social-delivered-notifications-v1'

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

function socialErrorText(code?: string) {
  if (code === 'rate_limited') return 'Çok hızlı işlem yaptın. Biraz bekleyip tekrar dene.'
  if (code === 'message_request_pending') return 'Bu mesaj isteği henüz yanıt bekliyor.'
  if (code === 'message_request_rejected') return 'Bu kullanıcı mesaj isteğini reddetti.'
  if (code === 'message_too_long') return 'Mesaj en fazla 500 karakter olabilir.'
  if (code === 'message_blocked') return 'Bu kullanıcıyla mesajlaşma kullanılamıyor.'
  if (code === 'room_full') return 'Bu oda dolu; en fazla 8 kişi birlikte dinleyebilir.'
  if (code === 'room_not_found') return 'Bu dinleme odası artık açık değil.'
  if (code === 'room_owner') return 'Odanın sahibisin; ayrılmak için odayı kapatabilirsin.'
  return 'Sosyal işlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.'
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

function socialDeviceId(isCompanion: boolean) {
  const key = isCompanion ? 'ritim-social-phone-id' : 'ritim-social-web-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const value = `${isCompanion ? 'phone' : 'web'}-${crypto.randomUUID()}`
  localStorage.setItem(key, value)
  return value
}

function defaultSocialUrl() {
  if (import.meta.env.PROD) return PUBLIC_SOCIAL_URL
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
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: {
      messagesEnabled: true,
      reactionsEnabled: true,
      deviceEnabled: false,
    },
    mutedUserIds: [],
    blockedUsers: [],
    selectedUserId: '',
  }))
  const selectedUserIdRef = useRef('')
  selectedUserIdRef.current = snapshot.selectedUserId
  const profileRef = useRef(localProfile)
  profileRef.current = localProfile
  const notificationPreferencesRef = useRef(snapshot.notificationPreferences)
  notificationPreferencesRef.current = snapshot.notificationPreferences
  const deliveredNotificationsRef = useRef<Set<string> | null>(null)
  if (!deliveredNotificationsRef.current) deliveredNotificationsRef.current = deliveredNotificationIds()
  const deliveredNotificationSet = deliveredNotificationsRef.current
  const connectSocialRef = useRef<() => void>(() => {})
  const playbackPublishRef = useRef({ roomId: '', revision: 0, signature: '' })

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
        feedback: {
          id: crypto.randomUUID(),
          tone: 'info',
          text: 'Sosyal bağlantı kesildi. Müzik ve telefon kumandası çalışmaya devam ediyor.',
        },
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
          feedback: previous.feedback,
          selectedUserId: selectedStillExists ? selected : next.selectedUserId,
        }
      })
    }
    const onSocialError = (error: { code?: string; event?: string }) => {
      // Profil yenileme arka planda gerçekleşir; kullanıcı eylemi değildir.
      // Mesaj hataları da acknowledgement callback'i üzerinden daha doğru
      // biçimde ele alınır ve burada ikinci kez başarı/hata bildirimini ezmez.
      if (
        error?.event === 'profile'
        || error?.event === 'message'
        || error?.event === 'room-membership'
      ) return
      setSnapshot((previous) => ({
        ...previous,
        feedback: {
          id: crypto.randomUUID(),
          tone: 'error',
          text: socialErrorText(error?.code),
        },
      }))
    }
    const onReportSaved = () => {
      setSnapshot((previous) => ({
        ...previous,
        feedback: {
          id: crypto.randomUUID(),
          tone: 'success',
          text: 'Şikâyet güvenli şekilde kaydedildi.',
        },
      }))
    }

    socialSocket.on('connect', onConnect)
    socialSocket.on('disconnect', onDisconnect)
    socialSocket.on('connect_error', onConnectError)
    socialSocket.on('social:state', onSocialState)
    socialSocket.on('social:error', onSocialError)
    socialSocket.on('social:report-saved', onReportSaved)
    socialSocket.io.on('reconnect_attempt', onReconnectAttempt)
    void connectSocial()

    return () => {
      disposed = true
      connectSocialRef.current = () => {}
      socialSocket.off('connect', onConnect)
      socialSocket.off('disconnect', onDisconnect)
      socialSocket.off('connect_error', onConnectError)
      socialSocket.off('social:state', onSocialState)
      socialSocket.off('social:error', onSocialError)
      socialSocket.off('social:report-saved', onReportSaved)
      socialSocket.io.off('reconnect_attempt', onReconnectAttempt)
      socialSocket.disconnect()
    }
  }, [isCompanion, joinSocialAccount])

  useEffect(() => {
    if (socialSocket.connected) socialSocket.emit('social:profile', { profile: localProfile })
  }, [localProfile])

  const ownedRoom = snapshot.rooms.find((room) => room.viewerRole === 'owner')
  const ownedRoomId = ownedRoom?.id || ''
  const ownedRoomRevision = Number(ownedRoom?.playback?.playbackRevision) || 0
  useEffect(() => {
    if (isCompanion || !socialSocket.connected || !ownedRoomId || !currentTrack.videoId) return
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
    socialSocket.emit('social:room-playback:update', {
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
  }, [currentTrack.isPlaying, currentTrack.position, currentTrack.videoId, isCompanion, ownedRoomId, ownedRoomRevision])

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
    socialSocket.emit('social:reaction', { targetUserId: userId, reaction })
  }, [])

  const sendMessage = useCallback((userId: string, text: string): Promise<boolean> => {
    const cleanText = text.trim().slice(0, 500)
    if (!cleanText) return Promise.resolve(false)
    if (!socialSocket.connected) {
      setSnapshot((current) => ({
        ...current,
        feedback: {
          id: crypto.randomUUID(),
          tone: 'error',
          text: 'Mesaj gönderilemedi; Sosyal bağlantısı çevrimdışı.',
        },
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
          feedback: {
            id: crypto.randomUUID(),
            tone: 'error',
            text: 'Sunucu mesajı zamanında onaylamadı. Mesajın taslakta tutuldu.',
          },
        }))
        resolve(false)
      }, 5_000)
      socialSocket.emit('social:message', {
        targetUserId: userId,
        text: cleanText,
        clientMessageId,
      }, (result: { ok?: boolean; duplicate?: boolean; code?: string } = {}) => {
        if (acknowledged) return
        acknowledged = true
        window.clearTimeout(timeout)
        setSnapshot((current) => ({
          ...current,
          feedback: {
            id: crypto.randomUUID(),
            tone: result.ok ? 'success' : 'error',
            text: result.ok
              ? (result.duplicate ? 'Mesaj daha önce güvenli şekilde gönderilmiş.' : 'Mesaj sunucuya ulaştı.')
              : socialErrorText(result.code),
          },
        }))
        resolve(Boolean(result.ok))
      })
    })
  }, [])

  const markConversationRead = useCallback((userId: string) => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:read', { targetUserId: userId })
  }, [])

  const respondToMessageRequest = useCallback((userId: string, action: 'accept' | 'reject') => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:request-response', { requesterUserId: userId, action })
  }, [])

  const reactToMessage = useCallback((
    userId: string,
    messageId: string,
    reaction: SocialMessageReaction['reaction'],
  ) => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:message-reaction', { targetUserId: userId, messageId, reaction })
  }, [])

  const markNotificationsRead = useCallback(() => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:notifications-read')
  }, [])

  const updateNotificationPreferences = useCallback((preferences: SocialNotificationPreferences) => {
    setSnapshot((current) => ({ ...current, notificationPreferences: preferences }))
    if (socialSocket.connected) socialSocket.emit('social:notification-preferences', preferences)
  }, [])

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
      setSnapshot((current) => ({ ...current, notificationPreferences: preferences }))
      setSnapshot((current) => ({
        ...current,
        feedback: {
          id: crypto.randomUUID(),
          tone: granted ? 'success' : 'info',
          text: granted ? 'Sistem bildirimleri açıldı.' : 'Sistem bildirimi izni verilmedi.',
        },
      }))
      if (socialSocket.connected) socialSocket.emit('social:notification-preferences', preferences)
    })()
  }, [])

  const toggleMute = useCallback((userId: string) => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:mute', { targetUserId: userId })
  }, [])

  const reportUser = useCallback((userId: string, reason: string, detail = '', messageId = '') => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:report', {
      targetUserId: userId,
      reason: reason.trim().slice(0, 120),
      detail: detail.trim().slice(0, 2000),
      messageId,
    })
  }, [])

  const clearFeedback = useCallback(() => {
    setSnapshot((current) => ({ ...current, feedback: undefined }))
  }, [])

  const toggleListeningWith = useCallback((userId: string) => {
    setSnapshot((current) => ({ ...current, selectedUserId: userId }))
    socialSocket.emit('social:listening', { targetUserId: userId })
  }, [])

  const joinRoom = useCallback((roomId: string) => {
    if (!socialSocket.connected) return
    socialSocket.emit('social:room-membership', { roomId }, (result: {
      ok?: boolean
      code?: string
      status?: 'joined' | 'left'
    } = {}) => {
      setSnapshot((current) => ({
        ...current,
        feedback: {
          id: crypto.randomUUID(),
          tone: result.ok ? 'success' : 'error',
          text: result.ok
            ? (result.status === 'left' ? 'Dinleme odasından ayrıldın.' : 'Dinleme odasına katıldın.')
            : socialErrorText(result.code),
        },
      }))
    })
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
      createRoom,
      updatePrivacy,
      blockUser,
      reconnectSocial,
    },
  }
}
