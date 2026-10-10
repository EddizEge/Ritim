import { useEffect, useRef, useState } from 'react'
import { Bell, SlidersHorizontal } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import {
  connectionLine,
  messagesBadgeCount,
  openRooms,
  unreadNotificationCount,
  type NotificationTarget,
} from '../../social/socialModel'
import type { SocialActions, SocialSettingsSection, SocialState } from '../../social/types'
import { ChatView } from './ChatView'
import { PhoneListeners } from './ListenersView'
import { MessagesList } from './MessagesView'
import { PhoneNotificationsScreen } from './NotificationsView'
import { CountBadge } from './primitives'
import { RoomView, RoomsList } from './RoomsView'
import { OfflineBand, PhoneSignedOut, useOfflineBand } from './StatusViews'
import { Toaster } from './Toaster'
import { useSocialHub } from './useSocialHub'

type Tab = 'listeners' | 'messages' | 'rooms'
type Screen =
  | { kind: 'list' }
  | { kind: 'chat'; userId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'notifications' }

export type MobileSocialHubProps = {
  state: SocialState
  actions: SocialActions
  // No Ritim Social session on this phone (the PC has not signed in yet).
  signedOut?: boolean
  onRetrySignIn?: () => Promise<unknown> | void
  onOpenSettings?: (section: SocialSettingsSection) => void
  // Chat, room and notifications are full screens: MobileApp hides the bottom
  // navigation and the mini player while one is open.
  onFullscreenChange?: (fullscreen: boolean) => void
  hasMiniPlayer?: boolean
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'listeners', label: 'Dinleyenler' },
  { id: 'messages', label: 'Mesajlar' },
  { id: 'rooms', label: 'Odalar' },
]

export function MobileSocialHub({ state, actions, signedOut = false, onRetrySignIn, onOpenSettings, onFullscreenChange, hasMiniPlayer = true }: MobileSocialHubProps) {
  const hub = useSocialHub(state, actions)
  const [tab, setTab] = useState<Tab>('listeners')
  const [screen, setScreen] = useState<Screen>({ kind: 'list' })
  const fullscreen = !signedOut && screen.kind !== 'list'
  const offlineBand = useOfflineBand(state)
  const status = connectionLine(state)
  const messagesBadge = messagesBadgeCount(state)
  const bellBadge = unreadNotificationCount(state)
  const roomCount = openRooms(state).length

  const fullscreenRef = useRef(onFullscreenChange)
  fullscreenRef.current = onFullscreenChange
  useEffect(() => {
    fullscreenRef.current?.(fullscreen)
  }, [fullscreen])
  useEffect(() => () => fullscreenRef.current?.(false), [])

  const back = () => setScreen({ kind: 'list' })

  // Android's back button returns from a full screen to the lists; on the
  // lists it keeps its normal behaviour.
  useEffect(() => {
    if (!fullscreen || !Capacitor.isNativePlatform()) return
    let disposed = false
    let remove: (() => void) | undefined
    void import('@capacitor/app').then(({ App }) => App.addListener('backButton', () => setScreen({ kind: 'list' })))
      .then((handle) => {
        if (disposed) void handle.remove()
        else remove = () => void handle.remove()
      })
      .catch(() => {})
    return () => {
      disposed = true
      remove?.()
    }
  }, [fullscreen])

  const openChat = (userId: string) => {
    actions.selectUser(userId)
    setScreen({ kind: 'chat', userId })
  }
  const openRoom = (roomId: string) => setScreen({ kind: 'room', roomId })
  const openTarget = (target: NotificationTarget) => {
    if (target.kind === 'profile') {
      setTab('listeners')
      setScreen({ kind: 'list' })
      return
    }
    openChat(target.userId)
  }

  let body
  if (signedOut) {
    body = <PhoneSignedOut onRetry={() => onRetrySignIn?.() ?? actions.reconnectSocial()} />
  } else if (screen.kind === 'chat') {
    body = <ChatView key={screen.userId} state={state} actions={actions} hub={hub} userId={screen.userId} desktop={false} onBack={back} />
  } else if (screen.kind === 'room') {
    body = <RoomView key={screen.roomId} state={state} actions={actions} roomId={screen.roomId} desktop={false} onBack={back} />
  } else if (screen.kind === 'notifications') {
    body = <PhoneNotificationsScreen state={state} actions={actions} onBack={back} onOpenTarget={openTarget} onOpenSettings={onOpenSettings} />
  } else {
    body = (
      <div className="rs-hub">
        <header className="rs-hub-header">
          <div className="rs-hub-title">
            <h1>Sosyal</h1>
            <p className={`rs-status-line is-${status.tone}`}><i aria-hidden="true" />{status.text}</p>
          </div>
          <button type="button" className="rs-header-button" onClick={() => setScreen({ kind: 'notifications' })} aria-label={bellBadge ? `Bildirimler, ${bellBadge} okunmamış` : 'Bildirimler'}>
            <Bell aria-hidden="true" /><CountBadge count={bellBadge} className="is-corner" />
          </button>
          {onOpenSettings ? (
            <button type="button" className="rs-header-button" onClick={() => onOpenSettings('social')} aria-label="Sosyal ayarları" title="Ayarlar › Sosyal">
              <SlidersHorizontal aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <nav className="rs-segments" aria-label="Sosyal bölümleri">
          {TABS.map((item) => {
            const label = item.id === 'messages' && messagesBadge ? `Mesajlar, ${messagesBadge} yeni` : item.id === 'rooms' ? `Odalar, ${roomCount} oda` : item.label
            return (
              <button key={item.id} type="button" className={tab === item.id ? 'is-current' : ''} aria-current={tab === item.id ? 'page' : undefined} aria-label={label} onClick={() => setTab(item.id)}>
                {item.label}
                {item.id === 'messages' ? <CountBadge count={messagesBadge} /> : null}
                {item.id === 'rooms' && roomCount ? <span className="rs-segment-count" aria-hidden="true">{roomCount}</span> : null}
              </button>
            )
          })}
        </nav>
        <main className="rs-hub-content">
          {offlineBand ? <OfflineBand state={state} onReconnect={actions.reconnectSocial} /> : null}
          {tab === 'listeners' ? <PhoneListeners state={state} actions={actions} hub={hub} onOpenChat={openChat} onOpenRoom={openRoom} /> : null}
          {tab === 'messages' ? <MessagesList state={state} hub={hub} onOpenChat={openChat} desktop={false} /> : null}
          {tab === 'rooms' ? <RoomsList state={state} actions={actions} onOpenRoom={openRoom} desktop={false} /> : null}
        </main>
      </div>
    )
  }

  return (
    <div className={`rs-root is-mobile ${fullscreen ? 'is-fullscreen' : ''} ${hasMiniPlayer ? '' : 'has-no-mini'}`}>
      {body}
      <Toaster toast={hub.toast} onDone={hub.dismissToast} placement={fullscreen ? 'screen' : hasMiniPlayer ? 'above-mini' : 'above-nav'} />
    </div>
  )
}
