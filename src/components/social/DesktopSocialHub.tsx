import { useEffect, useRef, useState } from 'react'
import { Bell, LogIn, LogOut, MessageCircle, Radio, SlidersHorizontal, UsersRound } from 'lucide-react'
import {
  accountActivity,
  activeUserCount,
  connectionLine,
  groupListeners,
  messagesBadgeCount,
  notificationViews,
  openRooms,
  ownRoom,
  requestWith,
  unreadNotificationCount,
  type NotificationTarget,
} from '../../social/socialModel'
import type { SocialActions, SocialSettingsSection, SocialState } from '../../social/types'
import { ChatView } from './ChatView'
import { DesktopListenersList, DesktopProfilePanel } from './ListenersView'
import { MessagesList } from './MessagesView'
import { MarkAllReadButton, NotificationsList } from './NotificationsView'
import { Avatar, CountBadge, EmptyState, EqualizerIcon } from './primitives'
import { DesktopRoomsHeaderAction, RoomView, RoomsList } from './RoomsView'
import { ConfirmSheet, Popover } from './Sheet'
import { DesktopSignedOut, OfflineBand, useOfflineBand } from './StatusViews'
import { Toaster } from './Toaster'
import { useSocialHub } from './useSocialHub'

type Section = 'listeners' | 'messages' | 'rooms' | 'notifications'

export type DesktopSocialHubProps = {
  state: SocialState
  actions: SocialActions
}

function AccountRow({ state, actions }: DesktopSocialHubProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const authentication = state.authentication
  const account = authentication?.authenticated && authentication.user
    ? { ...state.currentUser, ...authentication.user, presence: state.currentUser.presence }
    : state.currentUser
  const activity = accountActivity(state)
  const canSignIn = Boolean(authentication?.configured && !authentication.authenticated && actions.signIn)
  const canSignOut = Boolean(authentication?.authenticated && actions.signOut)
  const avatarUser = { ...account, presence: activity.tone === 'offline' || activity.tone === 'connecting' ? 'offline' as const : 'online' as const }
  return (
    <div className="rs-account">
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} label="Hesap menüsü" className="is-bottom-left">
        <div className="rs-account-menu-head">
          <b>{account.displayName}</b>
          <span>{activity.title}</span>
        </div>
        {actions.openSettings ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.openSettings?.('social') }}><SlidersHorizontal />Sosyal ayarları</button> : null}
        {canSignIn ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.signIn?.() }}><LogIn />Google ile giriş yap</button> : null}
        {canSignOut ? <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuOpen(false); setSignOutOpen(true) }}><LogOut />Hesaptan çık</button> : null}
      </Popover>
      <button type="button" className="rs-account-button rs-row" aria-haspopup="menu" aria-expanded={menuOpen} title={activity.title} onClick={() => setMenuOpen((value) => !value)}>
        <Avatar user={avatarUser} size={34} />
        <span className="rs-account-copy">
          <b>{account.displayName}</b>
          <span className={`rs-account-activity is-${activity.tone}`}>
            {activity.tone === 'playing' ? <EqualizerIcon /> : <i aria-hidden="true" />}
            <span>{activity.text}</span>
          </span>
        </span>
      </button>
      <ConfirmSheet open={signOutOpen} title="Ritim Sosyal hesabından çıkılsın mı?" confirmLabel="Hesaptan çık" desktop onClose={() => setSignOutOpen(false)} onConfirm={() => { setSignOutOpen(false); actions.signOut?.() }}>
        Mesajların ve odaların, yeniden giriş yapana kadar bu bilgisayarda görünmez. YouTube Music oturumun açık kalır.
      </ConfirmSheet>
    </div>
  )
}

export function DesktopSocialHub({ state, actions }: DesktopSocialHubProps) {
  const hub = useSocialHub(state, actions)
  const [section, setSection] = useState<Section>('listeners')
  const [roomId, setRoomId] = useState<string>()
  const [notificationId, setNotificationId] = useState<string>()
  const detailRef = useRef<HTMLElement | null>(null)
  const offlineBand = useOfflineBand(state)
  const authentication = state.authentication
  const needsSignIn = Boolean(authentication?.configured && authentication.required && !authentication.authenticated)

  // When the window is narrow the detail column wraps below the list; bring
  // it into view after a selection.
  const selectionKey = `${section}:${state.selectedUserId}:${roomId || ''}:${notificationId || ''}`
  const firstSelection = useRef(true)
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false
      return
    }
    const detail = detailRef.current
    if (!detail) return
    if (detail.getBoundingClientRect().top > window.innerHeight * 0.6) detail.scrollIntoView({ block: 'start' })
  }, [selectionKey])

  if (needsSignIn) {
    return (
      <div className="rs-root is-desktop is-signed-out">
        <DesktopSignedOut onSignIn={actions.signIn} />
        <Toaster toast={hub.toast} onDone={hub.dismissToast} placement="desktop" />
      </div>
    )
  }

  const listenerGroups = groupListeners(state.users)
  const fallbackListener = listenerGroups.listening[0] || listenerGroups.online[0] || listenerGroups.offline[0]
  const profileId = state.users.some((user) => user.id === state.selectedUserId) ? state.selectedUserId : fallbackListener?.id
  const rooms = openRooms(state)
  const shownRoomId = roomId && state.rooms.some((room) => room.id === roomId)
    ? roomId
    : state.activeRoomId || ownRoom(state)?.id || rooms[0]?.id
  const views = notificationViews(state)
  const selectedNotification = views.find((view) => view.id === notificationId)
  const requestUserId = selectedNotification?.target.kind === 'request' ? selectedNotification.target.userId : undefined

  const openChat = (userId: string) => {
    actions.selectUser(userId)
    setSection('messages')
  }
  const openRoom = (id: string) => {
    setRoomId(id)
    setSection('rooms')
  }
  const openTarget = (target: NotificationTarget, id: string) => {
    if (target.kind === 'request' && requestWith(state, target.userId, 'incoming')) {
      setNotificationId(id)
      return
    }
    actions.selectUser(target.userId)
    setSection(target.kind === 'profile' ? 'listeners' : 'messages')
  }

  const nav: Array<{ id: Section; label: string; icon: typeof UsersRound; count?: number; badge?: number }> = [
    { id: 'listeners', label: 'Dinleyenler', icon: UsersRound, count: activeUserCount(state.users) },
    { id: 'messages', label: 'Mesajlar', icon: MessageCircle, badge: messagesBadgeCount(state) },
    { id: 'rooms', label: 'Odalar', icon: Radio, count: rooms.length },
    { id: 'notifications', label: 'Bildirimler', icon: Bell, badge: unreadNotificationCount(state) },
  ]

  const status = connectionLine(state)
  const titles: Record<Section, string> = { listeners: 'Dinleyenler', messages: 'Mesajlar', rooms: 'Odalar', notifications: 'Bildirimler' }

  let list
  let detail
  if (section === 'listeners') {
    list = <DesktopListenersList state={state} selectedId={profileId} onSelect={actions.selectUser} />
    detail = profileId
      ? <DesktopProfilePanel key={profileId} state={state} actions={actions} hub={hub} userId={profileId} onOpenChat={openChat} onOpenRoom={openRoom} />
      : <EmptyState icon={<UsersRound aria-hidden="true" />} title="Henüz kimse yok">Başka bir Ritim hesabı bağlandığında burada görünecek.</EmptyState>
  } else if (section === 'messages') {
    list = <MessagesList state={state} hub={hub} onOpenChat={openChat} selectedId={state.selectedUserId} desktop />
    detail = state.selectedUserId
      ? <ChatView key={state.selectedUserId} state={state} actions={actions} hub={hub} userId={state.selectedUserId} desktop />
      : <EmptyState icon={<MessageCircle aria-hidden="true" />} title="Bir sohbet seç">Soldaki listeden bir sohbet ya da mesaj isteği aç.</EmptyState>
  } else if (section === 'rooms') {
    list = <RoomsList state={state} actions={actions} onOpenRoom={setRoomId} selectedId={shownRoomId} desktop />
    detail = shownRoomId
      ? <RoomView key={shownRoomId} state={state} actions={actions} roomId={shownRoomId} desktop />
      : <EmptyState icon={<Radio aria-hidden="true" />} title="Açık oda yok">Kendi odanı açınca bilgisayarında çalan müzik odaya yayınlanır.</EmptyState>
  } else {
    list = <NotificationsList state={state} actions={actions} onOpenTarget={openTarget} onOpenSettings={actions.openSettings} selectedId={notificationId} desktop />
    detail = requestUserId
      ? <ChatView key={requestUserId} state={state} actions={actions} hub={hub} userId={requestUserId} desktop />
      : <EmptyState icon={<Bell aria-hidden="true" />} title="Bildirim seç">Mesaj isteklerini burada yanıtlayabilir, diğer bildirimlerden ilgili yere gidebilirsin.</EmptyState>
  }

  return (
    <div className="rs-root is-desktop">
      <nav className="rs-side" aria-label="Sosyal bölümleri">
        <div className="rs-side-items">
          {nav.map((item) => {
            const Icon = item.icon
            const label = item.badge ? `${item.label}, ${item.badge} ${item.id === 'notifications' ? 'okunmamış' : 'yeni'}` : item.label
            return (
              <button key={item.id} type="button" className={`rs-side-item ${section === item.id ? 'is-current' : ''}`} aria-current={section === item.id ? 'page' : undefined} aria-label={label} onClick={() => setSection(item.id)}>
                <Icon aria-hidden="true" />
                <span className="rs-side-label">{item.label}</span>
                {item.badge ? <CountBadge count={item.badge} /> : item.count ? <small>{item.count}</small> : null}
              </button>
            )
          })}
        </div>
        <AccountRow state={state} actions={actions} />
      </nav>
      <section className="rs-list" aria-label={`${titles[section]} listesi`}>
        <div className="rs-list-head">
          <h1>{titles[section]}</h1>
          {section === 'listeners' ? <span className={`rs-status-line is-${status.tone}`}><i aria-hidden="true" />{status.text}</span> : null}
          {section === 'rooms' ? <DesktopRoomsHeaderAction state={state} actions={actions} /> : null}
          {section === 'notifications' ? <MarkAllReadButton state={state} actions={actions} /> : null}
        </div>
        {offlineBand ? <OfflineBand state={state} onReconnect={actions.reconnectSocial} compact /> : null}
        {list}
      </section>
      <section ref={detailRef} className="rs-detail" aria-label="Ayrıntı">
        {detail}
      </section>
      <Toaster toast={hub.toast} onDone={hub.dismissToast} placement="desktop" />
    </div>
  )
}
