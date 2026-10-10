import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Clock, LogOut, Monitor, Play, Plus, Radio, Send } from 'lucide-react'
import { formatTime } from '../../data'
import { SOCIAL_ROOM_MESSAGE_MAX_LENGTH } from '../../social/socialShared'
import {
  REACTION_NAMES,
  ROOM_REACTIONS,
  canJoinRoom,
  clockLabel,
  connectionTone,
  firstName,
  openRooms,
  ownRoom,
  possessive,
  roomOwner,
  roomStatus,
  roomSyncLabel,
  roomTrack,
  userFor,
} from '../../social/socialModel'
import type { SocialActions, SocialRoom, SocialState } from '../../social/types'
import { Cover } from '../Cover'
import { EmptyState, StatusChip, TrackProgress, useLivePosition } from './primitives'
import { ConfirmSheet } from './Sheet'

type RoomsProps = {
  state: SocialState
  actions: SocialActions
  onOpenRoom: (roomId: string) => void
  selectedId?: string
  desktop: boolean
}

function MemberInitials({ room, max = 4 }: { room: SocialRoom; max?: number }) {
  const shown = room.memberInitials.slice(0, max)
  return (
    <div className="rs-member-stack" aria-label={`${room.memberCount} kişi`}>
      {shown.map((initials, index) => <span key={`${initials}-${index}`} aria-hidden="true">{initials}</span>)}
      {room.memberCount > shown.length ? <span className="is-more" aria-hidden="true">+{room.memberCount - shown.length}</span> : null}
    </div>
  )
}

function roomProgress(state: SocialState, room: SocialRoom) {
  const track = roomTrack(state, room)
  const playback = room.playback
  if (!playback) return undefined
  return {
    key: `${playback.videoId}:${playback.playbackRevision}`,
    position: playback.playbackPositionMs / 1000,
    duration: track?.duration || 0,
    isPlaying: playback.playbackState === 'playing',
  }
}

function PlaybackLine({ state, room }: { state: SocialState; room: SocialRoom }) {
  const track = roomTrack(state, room)
  const live = useLivePosition(roomProgress(state, room))
  if (room.lifecycle === 'waiting' || !room.playback) {
    return <div className="rs-room-line is-muted"><Clock aria-hidden="true" />Oynatma bekleniyor</div>
  }
  return (
    <div className="rs-room-line">
      <Play aria-hidden="true" className="is-filled" />
      <span>{track?.title || room.title}{live.duration > 0 ? ` · ${formatTime(live.position)} / ${formatTime(live.duration)}` : ''}</span>
    </div>
  )
}

function OwnRoomCard({ state, actions, onOpenRoom, desktop }: Omit<RoomsProps, 'selectedId'>) {
  const room = ownRoom(state)
  const online = connectionTone(state.connectionStatus) === 'online'
  const track = state.currentUser.currentTrack
  if (!room) {
    if (desktop) return null
    return (
      <section className="rs-own-room is-empty" aria-label="Kendi odan">
        <span className="rs-own-room-icon"><Radio aria-hidden="true" /></span>
        <div><b>Kendi odanı aç</b><span>Bilgisayarında çalan müzik odaya yayınlanır. En çok 8 kişi.</span></div>
        <button type="button" className="rs-button is-primary is-pill" disabled={!online} onClick={actions.createRoom}>Oda aç</button>
      </section>
    )
  }
  const status = roomStatus(room)
  return (
    <section className={`rs-own-room ${desktop ? 'is-compact' : ''}`} aria-label="Kendi odan">
      <button type="button" className="rs-own-room-open rs-row" onClick={() => onOpenRoom(room.id)}>
        <Cover index={room.cover} thumbnailUrl={track?.thumbnailUrl} className="rs-cover" label="" />
        <span>
          <StatusChip label={status.label} tone={status.tone} compact={desktop} />
          <b>{room.title}</b>
          <small>Senin odan · {room.memberCount}/{room.maxMembers}{track?.title ? ` · ${track.title}` : ''}</small>
        </span>
      </button>
      <button type="button" className={`rs-button is-danger-outline ${desktop ? 'is-small' : 'is-wide'}`} disabled={!online} onClick={actions.createRoom}>{desktop ? 'Kapat' : 'Odayı kapat'}</button>
    </section>
  )
}

export function RoomsList({ state, actions, onOpenRoom, selectedId, desktop }: RoomsProps) {
  const online = connectionTone(state.connectionStatus) === 'online'
  const rooms = openRooms(state)
  const join = (room: SocialRoom) => {
    if (canJoinRoom(room)) actions.joinRoom(room.id)
    onOpenRoom(room.id)
  }
  return (
    <div className={`rs-list-body ${online ? '' : 'is-stale'}`}>
      {desktop ? <p className="rs-hint">Oda sahibinin bilgisayarında çalan müzik, katılan herkesin bilgisayarında aynı anda çalar. En çok 8 kişi.</p> : null}
      <OwnRoomCard state={state} actions={actions} onOpenRoom={onOpenRoom} desktop={desktop} />
      {desktop ? <h3 className="rs-group-title">Açık odalar · {rooms.length}</h3> : (
        <div className="rs-section-head"><h2>Açık odalar</h2><span>{rooms.length} oda</span></div>
      )}
      {rooms.length ? (
        <div className={desktop ? 'rs-select-list' : 'rs-stack'}>
          {rooms.map((room) => {
            const status = roomStatus(room)
            const owner = roomOwner(state, room)
            const offline = room.lifecycle === 'owner_offline'
            const full = room.memberCount >= room.maxMembers && !room.viewerRole
            const track = roomTrack(state, room)
            if (desktop) {
              return (
                <button key={room.id} type="button" className={`rs-select-row rs-row rs-room-row ${selectedId === room.id ? 'is-selected' : ''} ${offline ? 'is-offline' : ''}`} aria-pressed={selectedId === room.id} onClick={() => onOpenRoom(room.id)}>
                  <Cover index={room.cover} thumbnailUrl={track?.thumbnailUrl} className="rs-cover" label="" />
                  <span className="rs-person-copy">
                    <span className="rs-room-title"><b>{room.title}</b><StatusChip label={status.label} tone={status.tone} compact /></span>
                    <span>{owner.displayName} · {offline ? 'sahibi yeniden bağlanınca devam eder' : `${room.memberCount}/${room.maxMembers} kişi`}</span>
                  </span>
                  {room.viewerRole === 'listener' ? <span className="rs-tag is-live">İÇİNDESİN</span> : null}
                </button>
              )
            }
            return (
              <article key={room.id} className={`rs-card rs-room-card ${offline ? 'is-offline' : ''}`}>
                <div className="rs-room-card-top">
                  <Cover index={room.cover} thumbnailUrl={track?.thumbnailUrl} className="rs-cover" label="" />
                  <div>
                    <StatusChip label={status.label} tone={status.tone} />
                    <b>{room.title}</b>
                    <span>{owner.displayName} · {room.memberCount}/{room.maxMembers} kişi</span>
                  </div>
                </div>
                {offline ? (
                  <div className="rs-room-card-bottom">
                    <span className="rs-room-wait">Oda sahibinin bilgisayarı yeniden bağlanınca devam eder.</span>
                    <button type="button" className="rs-button is-ghost is-pill" disabled>Bekleniyor</button>
                  </div>
                ) : (
                  <>
                    <PlaybackLine state={state} room={room} />
                    <div className="rs-room-card-bottom">
                      <MemberInitials room={room} />
                      {room.viewerRole === 'listener'
                        ? <button type="button" className="rs-button is-success is-pill" onClick={() => onOpenRoom(room.id)}>İçindesin</button>
                        : <button type="button" className={`rs-button is-pill ${room.lifecycle === 'live' ? 'is-primary' : 'is-danger-outline'}`} disabled={!online || full} onClick={() => join(room)}>{full ? 'Dolu' : 'Katıl'}</button>}
                    </div>
                  </>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <EmptyState icon={<Radio aria-hidden="true" />} title="Şu an açık oda yok">{ownRoom(state) ? 'Arkadaşların oda açınca burada görünür.' : 'İlk odayı sen açabilirsin.'}</EmptyState>
      )}
    </div>
  )
}

export function DesktopRoomsHeaderAction({ state, actions }: { state: SocialState; actions: SocialActions }) {
  if (ownRoom(state)) return null
  return (
    <button type="button" className="rs-button is-primary is-pill is-small" disabled={connectionTone(state.connectionStatus) !== 'online'} onClick={actions.createRoom}>
      <Plus aria-hidden="true" />Oda aç
    </button>
  )
}

const SENDER_COLORS = ['#ff8f97', '#8cb8ff', '#c4b0ff', '#8fe3a9', '#f2c46b', '#7fd6d0']

function senderColor(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length]
}

export function RoomView({ state, actions, roomId, desktop, onBack }: {
  state: SocialState
  actions: SocialActions
  roomId: string
  desktop: boolean
  onBack?: () => void
}) {
  const room = state.rooms.find((candidate) => candidate.id === roomId)
  const lastRoomRef = useRef<SocialRoom | undefined>(room)
  if (room) lastRoomRef.current = room
  const shown = room || lastRoomRef.current
  const online = connectionTone(state.connectionStatus) === 'online'
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const chatRef = useRef<HTMLDivElement | null>(null)
  const messages = (state.roomMessages[roomId] || []).slice(-50)
  const [knownReactionIds] = useState(() => new Set((state.roomReactions[roomId] || []).map((reaction) => reaction.id)))

  useEffect(() => {
    const chat = chatRef.current
    if (chat) chat.scrollTop = chat.scrollHeight
  }, [messages.length])

  if (!shown) return <EmptyState icon={<Radio aria-hidden="true" />} title="Oda bulunamadı">Bu oda artık açık değil.</EmptyState>
  const closed = !room
  const owner = roomOwner(state, shown)
  const ownerIsMe = shown.ownerId === state.currentUser.id
  const member = Boolean(shown.viewerRole)
  const status = roomStatus(shown)
  const track = roomTrack(state, shown)
  const sync = roomSyncLabel(shown, !desktop)
  const reactions = (state.roomReactions[roomId] || []).filter((reaction) => reaction.expiresAt > Date.now()).slice(-6)
  const progress = roomProgress(state, shown)
  const playbackText = shown.viewerPlaybackStatus === 'unavailable'
    ? 'Bu parça bu bilgisayarda açılamadı'
    : ownerIsMe
      ? (desktop ? 'Bu bilgisayardan yayınlanıyor' : 'Bilgisayarından yayınlanıyor')
      : member
        ? (desktop ? 'Bu bilgisayarda çalıyor' : 'Ses bilgisayarından çalıyor')
        : (desktop ? 'Katılınca bu bilgisayarda da çalar' : 'Katılınca bilgisayarında çalar')
  const senderName = (senderId: string) => (senderId === state.currentUser.id ? 'Sen' : firstName(userFor(state, senderId).displayName))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || sending || !online || !member) return
    setSending(true)
    const sent = await actions.sendRoomMessage(roomId, draft)
    if (sent) setDraft('')
    setSending(false)
  }

  const headerAction = closed ? null : ownerIsMe ? (
    <button type="button" className="rs-button is-danger-outline is-pill" disabled={!online} onClick={() => setCloseOpen(true)}>Odayı kapat</button>
  ) : member ? (
    <button type="button" className="rs-button is-danger-outline is-pill" disabled={!online} onClick={() => { actions.joinRoom(roomId); onBack?.() }}><LogOut aria-hidden="true" />{desktop ? 'Odadan ayrıl' : 'Ayrıl'}</button>
  ) : (
    <button type="button" className="rs-button is-primary is-pill" disabled={!online || !canJoinRoom(shown)} onClick={() => actions.joinRoom(roomId)}>Odaya katıl</button>
  )

  // The gateway sends initials only; the owner is listed first.
  const ownerIndex = Math.max(0, shown.memberInitials.indexOf(owner.initials))
  const members = (
    <div className="rs-room-members" aria-label="Odadakiler">
      {shown.memberInitials.slice(0, 8).map((initials, index) => {
        const isOwner = index === ownerIndex
        const isMe = !isOwner && member && initials === state.currentUser.initials
        return (
          <div key={`${initials}-${index}`} className="rs-room-member">
            <span className={`rs-member-avatar ${isOwner ? 'is-owner' : ''}`} aria-hidden="true">{initials}</span>
            <span>{isOwner ? firstName(owner.displayName) : isMe ? 'Sen' : ''}</span>
            {isOwner ? <em>Sahip</em> : null}
          </div>
        )
      })}
    </div>
  )

  const reactionBar = (
    <>
      <div className="rs-room-reactions">
        {ROOM_REACTIONS.map((reaction) => (
          <button key={reaction} type="button" disabled={!online || !member || closed} aria-label={`Odaya ${REACTION_NAMES[reaction]} tepkisi gönder`} onClick={() => actions.sendRoomReaction(roomId, reaction)}>{reaction}</button>
        ))}
      </div>
      <div className="rs-reaction-stream" aria-live="polite">
        {reactions.map((reaction) => (
          <span key={reaction.id} className={knownReactionIds.has(reaction.id) ? '' : 'is-fresh'}>{reaction.reaction} {senderName(reaction.actorId)}</span>
        ))}
      </div>
    </>
  )

  const chat = (
    <section className="rs-room-chat" aria-label="Oda sohbeti">
      <div className="rs-room-chat-head"><b>Oda sohbeti</b><span>Oda kapanınca silinir</span></div>
      <div ref={chatRef} className="rs-room-chat-list">
        {messages.length ? messages.map((message) => (
          <div key={message.id} className="rs-room-message">
            <span><b style={{ color: message.senderId === state.currentUser.id ? undefined : senderColor(message.senderId) }}>{senderName(message.senderId)}</b><time>{clockLabel(message.sentAt)}</time></span>
            <p>{message.text}</p>
          </div>
        )) : <p className="rs-room-chat-empty">{member ? 'Odaya ilk mesajı sen yaz.' : 'Odaya katılınca sohbeti görürsün.'}</p>}
      </div>
      <form className="rs-composer is-room" onSubmit={submit}>
        <label className="rs-composer-field">
          <span className="rs-sr">Oda mesajı</span>
          <input value={draft} maxLength={SOCIAL_ROOM_MESSAGE_MAX_LENGTH} autoComplete="off" disabled={!member || closed} placeholder={member ? 'Odaya yaz…' : 'Yazmak için odaya katıl'} onChange={(event) => setDraft(event.target.value)} />
          <small>{draft.length}/{SOCIAL_ROOM_MESSAGE_MAX_LENGTH}</small>
        </label>
        <button type="submit" className="rs-send" disabled={!draft.trim() || sending || !online || !member || closed} aria-label="Oda mesajını gönder"><Send aria-hidden="true" /></button>
      </form>
    </section>
  )

  const nowPlaying = (
    <section className="rs-room-now" aria-label="Şu an çalan">
      {!desktop ? (
        <div className="rs-room-now-top">
          <Cover index={shown.cover} thumbnailUrl={track?.thumbnailUrl} className="rs-cover" label="" />
          <div>
            <StatusChip label={status.label} tone={status.tone} />
            <b>{track?.title || shown.title}</b>
            <span>{track?.artist || (shown.playback ? '' : 'Oynatma bekleniyor')}</span>
          </div>
        </div>
      ) : (
        <div className="rs-room-now-line"><b>{track?.title || shown.title}</b>{track?.artist ? <span>{track.artist}</span> : null}</div>
      )}
      <TrackProgress source={progress} withTimes />
      <div className="rs-room-now-foot">
        <span><Monitor aria-hidden="true" />{playbackText}</span>
        {member && sync ? <em><i aria-hidden="true" />{sync}</em> : null}
      </div>
    </section>
  )

  const closeSheet = (
    <ConfirmSheet open={closeOpen} title="Oda kapatılsın mı?" confirmLabel="Odayı kapat" desktop={desktop} onClose={() => setCloseOpen(false)} onConfirm={() => { setCloseOpen(false); actions.createRoom(); onBack?.() }}>
      Odadaki herkesin dinlemesi sona erer ve oda sohbeti silinir.
    </ConfirmSheet>
  )

  if (desktop) {
    return (
      <div className={`rs-room-detail ${online ? '' : 'is-stale'}`}>
        <div className="rs-room-hero">
          <Cover index={shown.cover} thumbnailUrl={track?.thumbnailUrl} className="rs-cover" label="" />
          <div>
            <StatusChip label={closed ? 'KAPANDI' : status.label} tone={closed ? 'offline' : status.tone} />
            <h2>{shown.title}</h2>
            <p>{ownerIsMe ? 'Senin odan' : `${possessive(owner.displayName)} odası`} · {shown.memberCount}/{shown.maxMembers} kişi</p>
          </div>
          {headerAction}
        </div>
        {nowPlaying}
        <div className="rs-room-columns">
          <div className="rs-room-side">
            <h3 className="rs-group-title">Odadakiler · {shown.memberCount}/{shown.maxMembers}</h3>
            {members}
            <h3 className="rs-group-title">Tepki gönder</h3>
            {reactionBar}
          </div>
          {chat}
        </div>
        {closeSheet}
      </div>
    )
  }

  return (
    <section className="rs-screen rs-room-screen" aria-label={`${shown.title} odası`}>
      <header className="rs-screen-header">
        <button type="button" className="rs-icon-button is-back" onClick={onBack} aria-label="Odalara dön"><ArrowLeft /></button>
        <div className="rs-screen-title">
          <b>{shown.title}</b>
          <span>{closed ? 'Oda kapandı' : `${ownerIsMe ? 'Senin odan' : `${possessive(owner.displayName)} odası`} · ${shown.memberCount}/${shown.maxMembers} kişi`}</span>
        </div>
        {headerAction}
      </header>
      <div className={`rs-room-body ${online ? '' : 'is-stale'}`}>
        {nowPlaying}
        {members}
        {reactionBar}
      </div>
      {chat}
      {closeSheet}
    </section>
  )
}
