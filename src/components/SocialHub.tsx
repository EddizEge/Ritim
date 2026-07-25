import { useDeferredValue, useMemo, useState, type FormEvent } from 'react'
import {
  Eye, Heart, MessageCircle, MoreVertical, Plus, Radio, RefreshCw, Search, Send, ShieldBan, SmilePlus,
  UsersRound, X,
} from 'lucide-react'
import { formatTime } from '../data'
import type { SocialActions, SocialState, SocialTrack, SocialUser } from '../social/types'
import { Cover } from './Cover'

type SocialProps = {
  state: SocialState
  actions: SocialActions
}

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
      <span>ALPHA.2</span>
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

function messageTime(sentAt: number) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(sentAt)
}

function ChatThread({ state, actions, mobile = false, onClose }: SocialProps & { mobile?: boolean; onClose?: () => void }) {
  const [message, setMessage] = useState('')
  const selectedUser = state.users.find((user) => user.id === state.selectedUserId)
  if (!selectedUser) return null
  const conversation = state.conversations[selectedUser.id] || []
  const listeningTogether = state.listeningWithUserId === selectedUser.id

  const submit = (event: FormEvent) => {
    event.preventDefault()
    actions.sendMessage(selectedUser.id, message)
    setMessage('')
  }

  return (
    <aside className={`social-chat ${mobile ? 'is-mobile' : ''}`} aria-label={`${selectedUser.displayName} ile sohbet`}>
      <header>
        {mobile ? <button className="social-chat-close" onClick={onClose} aria-label="Sohbeti kapat"><X /></button> : null}
        <SocialAvatar user={selectedUser} small />
        <span>
          <b>{selectedUser.displayName}</b>
          <small>{listeningTogether ? 'Birlikte dinliyorsunuz' : 'Çevrimiçi'}</small>
        </span>
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
      </header>
      <div className="social-chat-messages" aria-live="polite">
        {conversation.length ? conversation.map((item) => (
          <div className={item.senderId === state.currentUser.id ? 'social-message is-own' : 'social-message'} key={item.id}>
            <p>{item.text}</p>
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
      <form className="social-chat-composer" onSubmit={submit}>
        <SmilePlus />
        <input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} placeholder="Mesaj yaz…" aria-label="Mesaj" />
        <button disabled={!message.trim()} aria-label="Mesajı gönder"><Send /></button>
      </form>
    </aside>
  )
}

function DesktopUserRow({ user, selected, listening, actions }: { user: SocialUser; selected: boolean; listening: boolean; actions: SocialActions }) {
  return (
    <article className={`social-user-row ${selected ? 'is-selected' : ''} ${listening ? 'is-listening' : ''}`}>
      <button className="social-user-identity" onClick={() => actions.selectUser(user.id)}>
        <SocialAvatar user={user} />
        <span><b>{user.displayName}</b><small>{user.handle}</small></span>
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

  return (
    <section className="social-desktop-shell">
      <header className="social-desktop-header">
        <h1>Sosyal</h1>
        <label className="social-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Aktif kullanıcı ara" /></label>
        <span className="social-online-count"><i />{onlineCount} kişi çevrimiçi</span>
        <button className={state.activeRoomId ? 'social-create-room is-created' : 'social-create-room'} onClick={actions.createRoom}>
          {state.activeRoomId ? <Radio /> : <Plus />}
          {state.activeRoomId ? 'Odan hazır' : 'Dinleme odası oluştur'}
        </button>
      </header>
      <SocialConnectionNotice state={state} actions={actions} />
      <div className="social-desktop-layout">
        <div className="social-directory">
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
        <span><b>{user.displayName}</b><small>{user.handle}</small></span>
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

  return (
    <>
      <section className="mobile-social-hub">
        <div className="mobile-social-heading">
          <div><h1>Sosyal</h1><span><i />{onlineCount} kişi çevrimiçi</span></div>
          <button className={state.activeRoomId ? 'is-active' : ''} onClick={actions.createRoom}><Plus />{state.activeRoomId ? 'Odan hazır' : 'Oda oluştur'}</button>
        </div>
        <SocialConnectionNotice state={state} actions={actions} mobile />
        <label className="mobile-social-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Kullanıcı veya şarkı ara" /></label>
        <section className="mobile-social-rooms">
          <div className="mobile-social-section-title"><h2>Dinleme odaları</h2><Radio /></div>
          <div className="mobile-room-rail">
            {state.rooms.length ? state.rooms.map((room) => (
              <button className={state.activeRoomId === room.id ? 'mobile-room-card is-active' : 'mobile-room-card'} key={room.id}>
                <Cover index={room.cover} className="mobile-room-cover" label="" />
                <span className="mobile-room-live"><i />CANLI</span>
                <b>{room.title}</b>
                <small>{room.memberCount} kişi</small>
                <span className="mobile-room-members">{room.memberInitials.slice(0, 3).map((initials, index) => <i key={`${room.id}-${initials}`}>{initials}</i>)}{room.memberCount > 3 ? <em>+{room.memberCount - 3}</em> : null}</span>
              </button>
            )) : <div className="social-no-results"><Radio /><b>Henüz oda yok</b><p>İlk dinleme odasını yukarıdan oluştur.</p></div>}
          </div>
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
