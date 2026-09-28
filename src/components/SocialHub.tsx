import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Bell, BellRing, Check, Eye, Flag, Heart, MailQuestion, MessageCircle, MoreVertical, Plus, Radio,
  RefreshCw, Search, Send, ShieldBan, SmilePlus, Trash2, UsersRound, Volume2, VolumeX, X,
} from 'lucide-react'
import { formatTime } from '../data'
import type { SocialActions, SocialRoom, SocialState, SocialTrack, SocialUser } from '../social/types'
import { Cover } from './Cover'

type SocialProps = {
  state: SocialState
  actions: SocialActions
}

const QUICK_MESSAGE_REACTIONS = ['♥', '🔥', '😂', '👍'] as const
const QUICK_ROOM_REACTIONS = ['♥', '🔥', '👏', '🎵'] as const

function SocialAvatar({ user, small = false }: { user: SocialUser; small?: boolean }) {
  return (
    <span className={`social-avatar tone-${user.avatarTone % 6} ${small ? 'is-small' : ''}`} aria-label={`${user.displayName} avatarı`}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : user.initials}
      <i className={`is-${user.presence}`} />
    </span>
  )
}

function SocialConnectionNotice({ state, actions, mobile = false }: SocialProps & { mobile?: boolean }) {
  const online = state.connectionStatus === 'online'
  const connecting = state.connectionStatus === 'connecting'
  const text = online
    ? (mobile ? `${state.currentDeviceCount} cihazın tek Ritim hesabında senkron` : 'Ritim Social bağlantısı kuruldu.')
    : connecting
      ? 'Ritim Social’a bağlanıyor…'
      : 'Sosyal servis çevrimdışı; müzik ve telefon kumandası çalışmaya devam eder.'
  return (
    <div className={mobile ? `mobile-social-preview is-${state.connectionStatus}` : `social-preview-note is-${state.connectionStatus}`}>
      <span>ALPHA.4</span>
      <p>{text}</p>
      {online ? (
        <div className="social-privacy-controls">
          <Eye />
          <label>
            Profil
            <select
              aria-label="Profil görünürlüğü"
              value={state.privacy.profileVisibility}
              onChange={(event) => actions.updatePrivacy({
                ...state.privacy,
                profileVisibility: event.target.value as typeof state.privacy.profileVisibility,
              })}
            >
              <option value="everyone">Herkes</option>
              <option value="contacts">Konuştuklarım</option>
              <option value="hidden">Gizli</option>
            </select>
          </label>
          <label>
            Dinleme
            <select
              aria-label="Dinleme görünürlüğü"
              value={state.privacy.listeningVisibility}
              onChange={(event) => actions.updatePrivacy({
                ...state.privacy,
                listeningVisibility: event.target.value as typeof state.privacy.listeningVisibility,
              })}
            >
              <option value="everyone">Herkes</option>
              <option value="contacts">Konuştuklarım</option>
              <option value="hidden">Gizli</option>
            </select>
          </label>
        </div>
      ) : null}
      {!online && !connecting ? <button onClick={actions.reconnectSocial}><RefreshCw />Yeniden bağlan</button> : null}
    </div>
  )
}

function SocialFeedbackNotice({ state, actions, mobile = false }: SocialProps & { mobile?: boolean }) {
  const feedback = state.feedback

  useEffect(() => {
    if (!feedback) return
    const timeout = window.setTimeout(actions.clearFeedback, 5_000)
    return () => window.clearTimeout(timeout)
  }, [actions.clearFeedback, feedback])

  if (!feedback) return null
  return (
    <div
      className={`social-feedback-notice is-${feedback.tone} ${mobile ? 'is-mobile' : ''}`}
      role={feedback.tone === 'error' ? 'alert' : 'status'}
    >
      {feedback.tone === 'success' ? <Check /> : <MessageCircle />}
      <span>{feedback.text}</span>
      <button onClick={actions.clearFeedback} aria-label="Bildirimi kapat"><X /></button>
    </div>
  )
}

function matchesSocialQuery(user: SocialUser, query: string) {
  if (!query) return true
  const track = user.currentTrack
  return [user.displayName, user.handle, track?.title, track?.artist]
    .filter(Boolean)
    .some((value) => value?.toLocaleLowerCase('tr').includes(query))
}

function TrackProgress({ track }: { track: SocialTrack }) {
  const progress = track.duration > 0 ? Math.min(100, Math.max(0, (track.position / track.duration) * 100)) : 0
  return (
    <div className="social-track-progress" aria-label={`${formatTime(track.position)} / ${formatTime(track.duration)}`}>
      <span style={{ width: `${progress}%` }} />
    </div>
  )
}

function SocialTrackSummary({ track, compact = false }: { track?: SocialTrack; compact?: boolean }) {
  if (!track) return <div className="social-track-empty">Şu anda bir şey dinlemiyor</div>
  return (
    <div className={`social-track-summary ${compact ? 'is-compact' : ''}`}>
      <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="social-track-cover" label="" />
      <span className="social-track-copy">
        <b>{track.title}</b>
        <small>{track.artist}</small>
        <TrackProgress track={track} />
      </span>
    </div>
  )
}

function roomSyncLabel(room: SocialRoom) {
  const summary = room.syncSummary
  if (!summary) return ''
  if (summary.status === 'waiting') return 'Senkron bekleniyor'
  if (summary.status === 'unavailable') return 'Senkron kullanılamıyor'
  const status = summary.status === 'corrected' ? 'Düzeltildi' : 'Senkron'
  const roundTrip = Number.isFinite(summary.roundTripMs) ? `${Math.round(summary.roundTripMs || 0)} ms` : ''
  const drift = Number.isFinite(summary.driftMs) ? `sapma ${Math.round(summary.driftMs || 0)} ms` : ''
  return [status, roundTrip, drift].filter(Boolean).join(' • ')
}

function SocialRoomCard({
  room,
  actions,
  mobile = false,
}: {
  room: SocialRoom
  actions: SocialActions
  mobile?: boolean
}) {
  const full = room.memberCount >= room.maxMembers
  const owner = room.viewerRole === 'owner'
  const listening = room.viewerRole === 'listener'
  const ownerOffline = room.lifecycle === 'owner_offline'
  const unavailable = room.viewerPlaybackStatus === 'unavailable'
  const actionLabel = owner
    ? 'Senin odan'
    : listening
      ? 'Odadan ayrıl'
      : ownerOffline
        ? 'PC çevrimdışı'
        : full ? 'Oda dolu' : 'Odaya katıl'
  const playbackLabel = unavailable
    ? 'Bu parça bu bilgisayarda açılamadı'
    : room.playback
    ? `${room.playback.playbackState === 'playing' ? 'Çalıyor' : 'Duraklatıldı'} • ${formatTime(room.playback.playbackPositionMs / 1000)}`
    : ownerOffline ? 'Oda sahibi yeniden bağlanıyor' : 'Oynatma bekleniyor'
  const statusLabel = unavailable
    ? 'PARÇA AÇILAMADI'
    : ownerOffline
      ? 'PC ÇEVRİMDIŞI'
      : room.lifecycle === 'waiting' ? 'HAZIRLANIYOR' : 'CANLI'
  const syncLabel = roomSyncLabel(room)

  return (
    <article className={`${mobile ? 'mobile-room-card' : 'social-room-card'} ${room.viewerRole ? 'is-active' : ''} ${ownerOffline ? 'is-owner-offline' : ''} ${unavailable ? 'is-unavailable' : ''}`}>
      <Cover index={room.cover} className={mobile ? 'mobile-room-cover' : 'social-room-cover'} label="" />
      <span className={mobile ? 'mobile-room-live' : 'social-room-live'}><i />{statusLabel}</span>
      <b>{room.title}</b>
      <small>{room.memberCount}/{room.maxMembers} kişi • {playbackLabel}{syncLabel ? ` • ${syncLabel}` : ''}</small>
      <span className={mobile ? 'mobile-room-members' : 'social-room-members'}>
        {room.memberInitials.slice(0, 3).map((initials, index) => (
          <i key={`${room.id}-${initials}-${index}`}>{initials}</i>
        ))}
        {room.memberCount > 3 ? <em>+{room.memberCount - 3}</em> : null}
      </span>
      <button
        className={listening ? 'is-leave' : ''}
        disabled={owner || (!listening && (full || ownerOffline))}
        onClick={() => actions.joinRoom(room.id)}
      >
        {actionLabel}
      </button>
    </article>
  )
}

function DesktopRoomShelf({ state, actions }: SocialProps) {
  return (
    <section className="social-room-shelf" aria-label="Dinleme odaları">
      <div className="social-section-heading">
        <h2>Dinleme odaları</h2>
        <small>{state.rooms.length ? `${state.rooms.length} oda` : 'Henüz oda yok'}</small>
      </div>
      {state.rooms.length ? (
        <div className="social-room-list">
          {state.rooms.map((room) => <SocialRoomCard key={room.id} room={room} actions={actions} />)}
        </div>
      ) : (
        <div className="social-room-empty"><Radio /><span>İlk odayı yukarıdan oluştur.</span></div>
      )}
    </section>
  )
}

function RoomInteractionPanel({ state, actions, mobile = false }: SocialProps & { mobile?: boolean }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const roomId = state.activeRoomId
  const room = state.rooms.find((candidate) => candidate.id === roomId)
  if (!roomId || !room) return null
  const messages = state.roomMessages[roomId] || []
  const reactions = (state.roomReactions[roomId] || []).filter((reaction) => reaction.expiresAt > Date.now())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!message.trim() || sending || state.connectionStatus !== 'online') return
    setSending(true)
    const sent = await actions.sendRoomMessage(roomId, message)
    if (sent) setMessage('')
    setSending(false)
  }

  const senderName = (senderId: string) => {
    if (senderId === state.currentUser.id) return 'Sen'
    return state.users.find((user) => user.id === senderId)?.displayName || 'Oda üyesi'
  }

  return (
    <section className={`room-interaction-panel ${mobile ? 'is-mobile' : ''}`} aria-label={`${room.title} oda sohbeti`}>
      <header>
        <span><MessageCircle /><b>Oda sohbeti</b><small>{room.memberCount} kişi burada</small></span>
        <div className="room-quick-reactions" aria-label="Odaya hızlı tepki gönder">
          {QUICK_ROOM_REACTIONS.map((reaction) => (
            <button key={reaction} type="button" onClick={() => actions.sendRoomReaction(roomId, reaction)}>{reaction}</button>
          ))}
        </div>
      </header>
      {reactions.length ? (
        <div className="room-reaction-stream" aria-live="polite">
          {reactions.slice(-8).map((reaction) => (
            <span key={reaction.id} title={senderName(reaction.actorId)}>{reaction.reaction}</span>
          ))}
        </div>
      ) : null}
      <div className="room-message-list" aria-live="polite">
        {messages.length ? messages.slice(-20).map((item) => (
          <article className={item.senderId === state.currentUser.id ? 'is-own' : ''} key={item.id}>
            <span><b>{senderName(item.senderId)}</b><time dateTime={new Date(item.sentAt).toISOString()}>{messageTime(item.sentAt)}</time></span>
            <p>{item.text}</p>
          </article>
        )) : (
          <div className="room-message-empty"><SmilePlus /><span><b>Odaya bir şey söyle</b><small>Bu kısa sohbet oda kapanınca temizlenir.</small></span></div>
        )}
      </div>
      <form className="room-message-composer" onSubmit={submit}>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={280}
          placeholder="Odaya mesaj yaz…"
          aria-label="Oda mesajı"
          disabled={state.connectionStatus !== 'online'}
        />
        <small>{message.length}/280</small>
        <button type="submit" disabled={!message.trim() || sending || state.connectionStatus !== 'online'} aria-label="Oda mesajını gönder">
          {sending ? <RefreshCw className="is-spinning" /> : <Send />}
        </button>
      </form>
    </section>
  )
}

function messageTime(sentAt: number) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(sentAt)
}

function NotificationCenter({ state, actions, mobile = false }: SocialProps & { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const unreadCount = state.notifications.filter((notification) => !notification.read).length
  const preferences = state.notificationPreferences

  return (
    <div className={`social-notification-center ${mobile ? 'is-mobile' : ''}`}>
      <button
        className={unreadCount ? 'social-notification-trigger has-unread' : 'social-notification-trigger'}
        aria-label={`Bildirimler${unreadCount ? `, ${unreadCount} okunmamış` : ''}`}
        onClick={() => {
          setOpen((current) => !current)
          if (unreadCount) actions.markNotificationsRead()
        }}
      >
        {unreadCount ? <BellRing /> : <Bell />}
        {unreadCount ? <i>{Math.min(99, unreadCount)}</i> : null}
      </button>
      {open ? (
        <section className="social-notification-popover">
          <header><b>Bildirimler</b><small>{state.notifications.length ? `${state.notifications.length} olay` : 'Hepsi temiz'}</small></header>
          <div className="social-notification-preferences">
            <label><input type="checkbox" checked={preferences.messagesEnabled} onChange={(event) => actions.updateNotificationPreferences({ ...preferences, messagesEnabled: event.target.checked })} />Mesajlar</label>
            <label><input type="checkbox" checked={preferences.reactionsEnabled} onChange={(event) => actions.updateNotificationPreferences({ ...preferences, reactionsEnabled: event.target.checked })} />Tepkiler</label>
            <button className={preferences.deviceEnabled ? 'is-enabled' : ''} onClick={actions.requestDeviceNotifications}>
              <Bell />{preferences.deviceEnabled ? 'Sistem bildirimleri açık' : 'Sistem bildirimlerini aç'}
            </button>
          </div>
          <div className="social-notification-list">
            {state.notifications.length ? state.notifications.slice(0, 20).map((notification) => {
              const actor = state.users.find((user) => user.id === notification.actorId)
              const title = notification.kind === 'reaction'
                ? `${actor?.displayName || 'Bir kullanıcı'} mesajına ${notification.body} tepkisi verdi`
                : notification.kind === 'message_request'
                  ? `${actor?.displayName || 'Bir kullanıcı'} mesaj isteği gönderdi`
                  : `${actor?.displayName || 'Bir kullanıcı'} sana yazdı`
              return (
                <article className={notification.read ? '' : 'is-unread'} key={notification.id}>
                  <span><Bell /></span>
                  <div><b>{title}</b>{notification.kind !== 'reaction' ? <p>{notification.body}</p> : null}<time>{messageTime(notification.createdAt)}</time></div>
                </article>
              )
            }) : <div className="social-notification-empty"><Bell /><span>Yeni bildirimin yok.</span></div>}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function MessageRequestList({
  state,
  actions,
  mobile = false,
  onOpen,
}: SocialProps & { mobile?: boolean; onOpen?: () => void }) {
  const incomingRequests = state.messageRequests.filter((request) => request.direction === 'incoming')
  if (!incomingRequests.length) return null

  return (
    <section className={mobile ? 'mobile-social-requests' : 'social-request-panel'} aria-label="Mesaj istekleri">
      <div className="social-request-heading">
        <span><MailQuestion /><b>Mesaj istekleri</b></span>
        <small>{incomingRequests.length} bekleyen</small>
      </div>
      <div className="social-request-list">
        {incomingRequests.map((request) => {
          const user = state.users.find((candidate) => candidate.id === request.userId)
          if (!user) return null
          return (
            <article className="social-request-card" key={request.userId}>
              <button
                className="social-request-person"
                onClick={() => {
                  actions.selectUser(user.id)
                  onOpen?.()
                }}
              >
                <SocialAvatar user={user} small />
                <span><b>{user.displayName}</b><small>{request.preview}</small></span>
              </button>
              <div className="social-request-actions">
                <button
                  className="is-accept"
                  onClick={() => actions.respondToMessageRequest(user.id, 'accept')}
                ><Check />Kabul et</button>
                <button
                  className="is-reject"
                  aria-label={`${user.displayName} mesaj isteğini reddet`}
                  onClick={() => actions.respondToMessageRequest(user.id, 'reject')}
                ><Trash2 />Reddet</button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function BlockedUsersPanel({ state, actions, mobile = false }: SocialProps & { mobile?: boolean }) {
  if (!state.blockedUsers.length) return null
  return (
    <section className={mobile ? 'mobile-social-blocked' : 'social-blocked-panel'}>
      <div className="social-request-heading">
        <span><ShieldBan /><b>Engellenenler</b></span>
        <small>{state.blockedUsers.length} kişi</small>
      </div>
      <div className="social-blocked-list">
        {state.blockedUsers.map((user) => (
          <article key={user.id}>
            <span><SocialAvatar user={user} small /><b>{user.displayName}</b></span>
            <button onClick={() => actions.blockUser(user.id)}>Engeli kaldır</button>
          </article>
        ))}
      </div>
    </section>
  )
}

function ChatThread({ state, actions, mobile = false, onClose }: SocialProps & { mobile?: boolean; onClose?: () => void }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('Spam')
  const [reportDetail, setReportDetail] = useState('')
  const [reportSaved, setReportSaved] = useState(false)
  const selectedUserId = state.selectedUserId
  const selectedUser = state.users.find((user) => user.id === selectedUserId)
  const conversation = selectedUserId ? state.conversations[selectedUserId] || [] : []
  const unreadCount = selectedUserId ? state.unreadCounts[selectedUserId] || 0 : 0
  const newestMessageId = conversation.at(-1)?.id || ''
  const messageRequest = state.messageRequests.find((request) => request.userId === selectedUserId)
  const incomingRequest = messageRequest?.direction === 'incoming'
  const outgoingRequest = messageRequest?.direction === 'outgoing'

  useEffect(() => {
    if (selectedUserId && unreadCount && newestMessageId) actions.markConversationRead(selectedUserId)
  }, [actions.markConversationRead, newestMessageId, selectedUserId, unreadCount])

  if (!selectedUser) return null
  const listeningTogether = state.listeningWithUserId === selectedUser.id
  const muted = state.mutedUserIds.includes(selectedUser.id)
  const reportMessageId = [...conversation].reverse().find((item) => item.senderId === selectedUser.id)?.id

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sending || state.connectionStatus !== 'online') return
    setSending(true)
    const sent = await actions.sendMessage(selectedUser.id, message)
    if (sent) setMessage('')
    setSending(false)
  }

  return (
    <aside className={`social-chat ${mobile ? 'is-mobile' : ''}`} aria-label={`${selectedUser.displayName} ile sohbet`}>
      <header>
        {mobile ? <button className="social-chat-close" onClick={onClose} aria-label="Sohbeti kapat"><X /></button> : null}
        <SocialAvatar user={selectedUser} small />
        <span>
          <b>{selectedUser.displayName}</b>
          <small>{incomingRequest ? 'Mesaj isteği gönderdi' : outgoingRequest ? 'İsteğin yanıtını bekliyor' : listeningTogether ? 'Birlikte dinliyorsunuz' : 'Çevrimiçi'}</small>
        </span>
        <div className="social-chat-security-actions">
          <button
            className={muted ? 'is-active' : ''}
            aria-label={muted ? 'Konuşmanın sesini aç' : 'Konuşmayı sessize al'}
            title={muted ? 'Sesi aç' : 'Sessize al'}
            onClick={() => actions.toggleMute(selectedUser.id)}
          >{muted ? <VolumeX /> : <Volume2 />}</button>
          <button aria-label={`${selectedUser.displayName} kullanıcısını şikâyet et`} title="Şikâyet et" onClick={() => setReportOpen(true)}><Flag /></button>
          <button
            aria-label={`${selectedUser.displayName} kullanıcısını engelle`}
            title="Kullanıcıyı engelle"
            onClick={() => {
              if (window.confirm(`${selectedUser.displayName} kullanıcısını engellemek istiyor musun?`)) {
                actions.blockUser(selectedUser.id)
                onClose?.()
              }
            }}
          >
            <ShieldBan />
          </button>
        </div>
      </header>
      {reportOpen ? (
        <form
          className="social-report-panel"
          onSubmit={(event) => {
            event.preventDefault()
            actions.reportUser(selectedUser.id, reportReason, reportDetail, reportMessageId)
            setReportSaved(true)
            setReportDetail('')
          }}
        >
          <header><b>{selectedUser.displayName} için şikâyet</b><button type="button" onClick={() => { setReportOpen(false); setReportSaved(false) }} aria-label="Şikâyeti kapat"><X /></button></header>
          {reportSaved ? <div className="social-report-saved"><Check />Şikâyet güvenli şekilde kaydedildi.</div> : (
            <>
              <label>Neden<select value={reportReason} onChange={(event) => setReportReason(event.target.value)}><option>Spam</option><option>Taciz</option><option>Uygunsuz içerik</option><option>Diğer</option></select></label>
              <label>Açıklama<textarea value={reportDetail} onChange={(event) => setReportDetail(event.target.value)} maxLength={2000} placeholder="İsteğe bağlı ayrıntı" /></label>
              <button className="social-report-submit" type="submit"><Flag />Şikâyeti gönder</button>
            </>
          )}
        </form>
      ) : null}
      <div className="social-chat-messages" aria-live="polite">
        {conversation.length ? conversation.map((item) => (
          <div className={item.senderId === state.currentUser.id ? 'social-message is-own' : 'social-message'} key={item.id}>
            <p>{item.text}</p>
            {item.reactions.length ? (
              <div className="social-message-reaction-summary">
                {item.reactions.map((itemReaction) => <span key={itemReaction.actorId}>{itemReaction.reaction}</span>)}
              </div>
            ) : null}
            <div className="social-message-reaction-picker" aria-label="Hızlı tepkiler">
              {QUICK_MESSAGE_REACTIONS.map((reaction) => (
                <button
                  className={item.reactions.some((itemReaction) => (
                    itemReaction.actorId === state.currentUser.id && itemReaction.reaction === reaction
                  )) ? 'is-selected' : ''}
                  key={reaction}
                  aria-label={`${reaction} tepkisi ver`}
                  onClick={() => actions.reactToMessage(selectedUser.id, item.id, reaction)}
                >{reaction}</button>
              ))}
            </div>
            <time dateTime={new Date(item.sentAt).toISOString()}>{messageTime(item.sentAt)}</time>
          </div>
        )) : (
          <div className="social-chat-empty">
            <MessageCircle />
            <b>İlk mesajı sen gönder</b>
            <p>Dinlediğiniz parçalar üzerine konuşmaya başlayabilirsiniz.</p>
          </div>
        )}
        {selectedUser.currentTrack ? (
          <div className="social-chat-track">
            <SocialTrackSummary track={selectedUser.currentTrack} compact />
            <small>{listeningTogether ? 'Birlikte dinliyorsunuz' : `${selectedUser.displayName} dinliyor`}</small>
          </div>
        ) : null}
      </div>
      {incomingRequest ? (
        <div className="social-chat-request-actions">
          <button className="is-reject" onClick={() => { actions.respondToMessageRequest(selectedUser.id, 'reject'); onClose?.() }}><Trash2 />Reddet</button>
          <button className="is-accept" onClick={() => actions.respondToMessageRequest(selectedUser.id, 'accept')}><Check />Kabul et</button>
        </div>
      ) : outgoingRequest ? (
        <div className="social-chat-request-pending"><MailQuestion /><span><b>Mesaj isteği gönderildi</b><small>{selectedUser.displayName} kabul ettiğinde konuşmaya devam edebilirsin.</small></span></div>
      ) : (
        <form className="social-chat-composer" onSubmit={submit}>
          <SmilePlus />
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={500}
            placeholder={state.connectionStatus === 'online' ? 'Mesaj yaz…' : 'Bağlantı gelince gönderebilirsin'}
            aria-label="Mesaj"
          />
          <button disabled={!message.trim() || sending || state.connectionStatus !== 'online'} aria-label="Mesajı gönder">
            {sending ? <RefreshCw className="is-spinning" /> : <Send />}
          </button>
        </form>
      )}
    </aside>
  )
}

function DesktopUserRow({ user, selected, listening, muted, unread, actions }: { user: SocialUser; selected: boolean; listening: boolean; muted: boolean; unread: number; actions: SocialActions }) {
  return (
    <article className={`social-user-row ${selected ? 'is-selected' : ''} ${listening ? 'is-listening' : ''}`}>
      <button className="social-user-identity" onClick={() => actions.selectUser(user.id)}>
        <SocialAvatar user={user} />
        <span><b>{user.displayName}{muted ? <VolumeX className="social-muted-icon" /> : null}{unread ? <em className="social-unread-badge">{Math.min(99, unread)}</em> : null}</b><small>{user.handle}</small></span>
      </button>
      <SocialTrackSummary track={user.currentTrack} />
      <div className="social-user-actions">
        <button onClick={() => actions.reactToUser(user.id)}><Heart fill={user.lastReaction === '♥' ? 'currentColor' : 'none'} /><span>Tepki</span><small>{user.lastReaction} {user.reactionCount}</small></button>
        <button onClick={() => actions.selectUser(user.id)}><MessageCircle /><span>Mesaj</span></button>
        <button className={listening ? 'is-active' : 'is-primary'} onClick={() => actions.toggleListeningWith(user.id)}><UsersRound /><span>{listening ? 'Birliktesiniz' : 'Birlikte dinle'}</span></button>
      </div>
      <button className="social-user-more" aria-label={`${user.displayName} seçenekleri`}><MoreVertical /></button>
    </article>
  )
}

export function DesktopSocialHub({ state, actions }: SocialProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('tr'))
  const visibleUsers = useMemo(() => {
    return state.users.filter((user) => matchesSocialQuery(user, deferredQuery))
  }, [deferredQuery, state.users])
  const onlineCount = state.users.filter((user) => user.presence === 'online').length
  const ownedRoom = state.rooms.find((room) => room.viewerRole === 'owner')

  return (
    <section className="social-desktop-shell">
      <header className="social-desktop-header">
        <h1>Sosyal</h1>
        <label className="social-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Aktif kullanıcı ara" /></label>
        <span className="social-online-count"><i />{onlineCount} kişi çevrimiçi</span>
        <NotificationCenter state={state} actions={actions} />
        <button className={ownedRoom ? 'social-create-room is-created' : 'social-create-room'} onClick={actions.createRoom}>
          {ownedRoom ? <Radio /> : <Plus />}
          {ownedRoom ? 'Odayı kapat' : 'Dinleme odası oluştur'}
        </button>
      </header>
      <SocialConnectionNotice state={state} actions={actions} />
      <SocialFeedbackNotice state={state} actions={actions} />
      <div className="social-desktop-layout">
        <div className="social-directory">
          <DesktopRoomShelf state={state} actions={actions} />
          <RoomInteractionPanel state={state} actions={actions} />
          <MessageRequestList state={state} actions={actions} />
          <BlockedUsersPanel state={state} actions={actions} />
          <div className="social-section-heading">
            <h2>Şu an dinleyenler</h2>
            <small>{visibleUsers.length} kullanıcı gösteriliyor</small>
          </div>
          <div className="social-user-list">
            {visibleUsers.length ? visibleUsers.map((user) => (
              <DesktopUserRow
                key={user.id}
                user={user}
                selected={state.selectedUserId === user.id}
                listening={state.listeningWithUserId === user.id}
                muted={state.mutedUserIds.includes(user.id)}
                unread={state.unreadCounts[user.id] || 0}
                actions={actions}
              />
            )) : (
              <div className="social-no-results"><UsersRound /><b>{deferredQuery ? 'Kullanıcı bulunamadı' : 'Henüz başka kullanıcı yok'}</b><p>{deferredQuery ? 'Başka bir ad, kullanıcı adı veya parça ara.' : 'Başka bir Ritim hesabı bağlandığında burada görünecek.'}</p></div>
            )}
          </div>
        </div>
        <ChatThread state={state} actions={actions} />
      </div>
    </section>
  )
}

function MobileSocialUserRow({ user, state, actions, onMessage }: { user: SocialUser; state: SocialState; actions: SocialActions; onMessage: () => void }) {
  const listening = state.listeningWithUserId === user.id
  return (
    <article className={`mobile-social-user ${listening ? 'is-listening' : ''}`}>
      <button className="mobile-social-person" onClick={() => actions.selectUser(user.id)}>
        <SocialAvatar user={user} />
        <span><b>{user.displayName}{state.mutedUserIds.includes(user.id) ? <VolumeX className="social-muted-icon" /> : null}{state.unreadCounts[user.id] ? <em className="social-unread-badge">{Math.min(99, state.unreadCounts[user.id])}</em> : null}</b><small>{user.handle}</small></span>
      </button>
      <SocialTrackSummary track={user.currentTrack} compact />
      <div className="mobile-social-actions">
        <button className="mobile-social-reaction" onClick={() => actions.reactToUser(user.id)} aria-label={`${user.displayName} için tepki gönder`}>
          <Heart fill="currentColor" /><span>{user.reactionCount}</span>
        </button>
        <button onClick={() => { actions.selectUser(user.id); onMessage() }} aria-label={`${user.displayName} kullanıcısına mesaj gönder`}><MessageCircle /></button>
        <button className={listening ? 'is-active' : 'is-primary'} onClick={() => actions.toggleListeningWith(user.id)}>{listening ? 'Birlikte' : 'Katıl'}</button>
      </div>
    </article>
  )
}

export function MobileSocialHub({ state, actions }: SocialProps) {
  const [chatOpen, setChatOpen] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('tr'))
  const visibleUsers = useMemo(
    () => state.users.filter((user) => matchesSocialQuery(user, deferredQuery)),
    [deferredQuery, state.users],
  )
  const onlineCount = state.users.filter((user) => user.presence === 'online').length
  const ownedRoom = state.rooms.find((room) => room.viewerRole === 'owner')

  return (
    <>
      <section className="mobile-social-hub">
        <div className="mobile-social-heading">
          <div><h1>Sosyal</h1><span><i />{onlineCount} kişi çevrimiçi</span></div>
          <button className={ownedRoom ? 'is-active' : ''} onClick={actions.createRoom}><Plus />{ownedRoom ? 'Odayı kapat' : 'Oda oluştur'}</button>
        </div>
        <SocialConnectionNotice state={state} actions={actions} mobile />
        <SocialFeedbackNotice state={state} actions={actions} mobile />
        <NotificationCenter state={state} actions={actions} mobile />
        <label className="mobile-social-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Kullanıcı veya şarkı ara" /></label>
        <MessageRequestList state={state} actions={actions} mobile onOpen={() => setChatOpen(true)} />
        <BlockedUsersPanel state={state} actions={actions} mobile />
        <section className="mobile-social-rooms">
          <div className="mobile-social-section-title"><h2>Dinleme odaları</h2><Radio /></div>
          <div className="mobile-room-rail">
            {state.rooms.length ? state.rooms.map((room) => (
              <SocialRoomCard key={room.id} room={room} actions={actions} mobile />
            )) : <div className="social-no-results"><Radio /><b>Henüz oda yok</b><p>İlk dinleme odasını yukarıdan oluştur.</p></div>}
          </div>
          <RoomInteractionPanel state={state} actions={actions} mobile />
        </section>
        <section className="mobile-social-list">
          <div className="mobile-social-section-title"><h2>Şu an dinleyenler</h2><small>{onlineCount} kişi</small></div>
          {visibleUsers.length ? visibleUsers.map((user) => (
            <MobileSocialUserRow key={user.id} user={user} state={state} actions={actions} onMessage={() => setChatOpen(true)} />
          )) : <div className="social-no-results"><UsersRound /><b>{deferredQuery ? 'Kullanıcı bulunamadı' : 'Henüz başka kullanıcı yok'}</b><p>{deferredQuery ? 'Başka bir ad, kullanıcı adı veya şarkı ara.' : 'Başka bir Ritim hesabı bağlandığında burada görünecek.'}</p></div>}
        </section>
      </section>
      {chatOpen ? (
        <div className="mobile-social-chat-backdrop" role="presentation" onClick={() => setChatOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <ChatThread state={state} actions={actions} mobile onClose={() => setChatOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  )
}
