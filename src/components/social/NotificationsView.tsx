import { useMemo, useRef } from 'react'
import { ArrowLeft, BellOff, ChevronRight, Mail, MessageCircle, Monitor, SlidersHorizontal } from 'lucide-react'
import {
  connectionTone,
  groupNotifications,
  notificationViews,
  relativeTimeLabel,
  type NotificationTarget,
  type NotificationView,
} from '../../social/socialModel'
import type { SocialActions, SocialSettingsSection, SocialState } from '../../social/types'
import { Avatar, EmptyState } from './primitives'

type NotificationsProps = {
  state: SocialState
  actions: SocialActions
  onOpenTarget: (target: NotificationTarget, notificationId: string) => void
  onOpenSettings?: (section: SocialSettingsSection) => void
  selectedId?: string
}

function TypeBadge({ view }: { view: NotificationView }) {
  if (view.badge.kind === 'request') return <span className="rs-type-badge is-request"><Mail /></span>
  if (view.badge.kind === 'message') return <span className="rs-type-badge is-message"><MessageCircle /></span>
  return <span className="rs-type-badge is-emoji">{view.badge.emoji}</span>
}

function NotificationRow({ view, desktop, selected, onOpen }: { view: NotificationView; desktop: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`rs-notification rs-row ${view.read ? '' : 'is-unread'} ${selected ? 'is-selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <Avatar user={view.actor} size={desktop ? 40 : 44} presence={false} badge={<TypeBadge view={view} />} />
      <span className="rs-notification-copy">
        <span className="rs-notification-text"><b>{view.actor.displayName}</b> {view.action}{desktop && view.quote && view.kind === 'message' ? `: “${view.quote}”` : ''}</span>
        {view.quote && !(desktop && view.kind === 'message') ? <span className="rs-notification-quote">“{view.quote}”</span> : null}
        <time>{relativeTimeLabel(view.createdAt)}</time>
      </span>
      <i className="rs-unread-dot" aria-hidden="true" />
      <span className="rs-sr">{view.read ? '' : 'Okunmadı'}</span>
    </button>
  )
}

// "Yeni" keeps what was unread when the screen opened, so "Tümünü okundu say"
// only clears the dots instead of reshuffling the list.
function useFreshIds(views: NotificationView[]) {
  const freshRef = useRef<Set<string> | null>(null)
  if (!freshRef.current) freshRef.current = new Set(views.filter((view) => !view.read).map((view) => view.id))
  for (const view of views) if (!view.read) freshRef.current.add(view.id)
  return freshRef.current
}

export function NotificationsList({ state, actions, onOpenTarget, onOpenSettings, selectedId, desktop }: NotificationsProps & { desktop: boolean }) {
  const views = useMemo(() => notificationViews(state), [state])
  const fresh = useFreshIds(views)
  const groups = groupNotifications(views, fresh)
  const online = connectionTone(state.connectionStatus) === 'online'
  const deviceEnabled = state.notificationPreferences.deviceEnabled

  return (
    <div className={`rs-list-body ${online ? '' : 'is-stale'}`}>
      {desktop ? (
        <div className={`rs-device-row ${deviceEnabled ? 'is-on' : ''}`}>
          <Monitor aria-hidden="true" />
          <span>{deviceEnabled ? 'Windows bildirimleri açık' : 'Windows bildirimleri kapalı'}</span>
          {!deviceEnabled ? <button type="button" className="rs-button is-outline is-tiny" onClick={actions.requestDeviceNotifications}>Aç</button> : null}
          {onOpenSettings ? <button type="button" className="rs-button is-outline is-tiny" onClick={() => onOpenSettings('notifications')}>Ayarlar</button> : null}
        </div>
      ) : !deviceEnabled ? (
        <div className="rs-device-band">
          <span className="rs-device-band-icon"><BellOff aria-hidden="true" /></span>
          <div><b>Telefon bildirimleri kapalı</b><span>Yeni mesaj ve istekleri bildirim olarak göster.</span></div>
          <button type="button" className="rs-button is-light is-pill" onClick={actions.requestDeviceNotifications}>Aç</button>
        </div>
      ) : null}

      {groups.fresh.length ? (
        <>
          <h3 className="rs-group-title">Yeni</h3>
          <div className="rs-notifications">
            {groups.fresh.map((view) => <NotificationRow key={view.id} view={view} desktop={desktop} selected={selectedId === view.id} onOpen={() => onOpenTarget(view.target, view.id)} />)}
          </div>
        </>
      ) : null}
      {groups.earlier.length ? (
        <>
          <h3 className="rs-group-title">Daha önce</h3>
          <div className="rs-notifications is-earlier">
            {groups.earlier.map((view) => <NotificationRow key={view.id} view={view} desktop={desktop} selected={selectedId === view.id} onOpen={() => onOpenTarget(view.target, view.id)} />)}
          </div>
        </>
      ) : null}
      {!views.length ? <EmptyState title="Henüz bildirim yok">Mesajlar, istekler ve tepkiler burada görünür.</EmptyState> : null}

      {!desktop && onOpenSettings ? (
        <button type="button" className="rs-settings-link rs-row" onClick={() => onOpenSettings('notifications')}>
          <SlidersHorizontal aria-hidden="true" />
          <span><b>Bildirim ayarları</b><small>Mesaj, tepki ve sistem bildirimleri Ayarlar’da</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export function MarkAllReadButton({ state, actions }: { state: SocialState; actions: SocialActions }) {
  const unread = notificationViews(state).some((view) => !view.read)
  return (
    <button type="button" className="rs-text-button" disabled={!unread || connectionTone(state.connectionStatus) !== 'online'} onClick={actions.markNotificationsRead}>
      Tümünü okundu say
    </button>
  )
}

export function PhoneNotificationsScreen(props: NotificationsProps & { onBack: () => void }) {
  return (
    <section className="rs-screen rs-notifications-screen" aria-label="Bildirimler">
      <header className="rs-screen-header">
        <button type="button" className="rs-icon-button is-back" onClick={props.onBack} aria-label="Sosyal’e dön"><ArrowLeft /></button>
        <h1>Bildirimler</h1>
        <MarkAllReadButton state={props.state} actions={props.actions} />
      </header>
      <div className="rs-screen-scroll">
        <NotificationsList {...props} desktop={false} />
      </div>
    </section>
  )
}
