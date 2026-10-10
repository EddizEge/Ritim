import { useDeferredValue, useState } from 'react'
import { Ban, Flag, Heart, MessageCircle, Radio, Search, Volume2, VolumeX } from 'lucide-react'
import {
  canJoinRoom,
  clockLabel,
  connectionTone,
  dative,
  groupListeners,
  idleActivityLine,
  presenceLabel,
  requestWith,
  roomStripFor,
  userFor,
} from '../../social/socialModel'
import type { SocialActions, SocialRoom, SocialState, SocialUser } from '../../social/types'
import { Cover } from '../Cover'
import { Avatar, CountBadge, EmptyState, TrackProgress } from './primitives'
import { BlockSheet, ReportSheet } from './Sheet'
import type { SocialHubModel } from './useSocialHub'

type ListProps = {
  state: SocialState
  actions: SocialActions
  hub: SocialHubModel
  onOpenChat: (userId: string) => void
  onOpenRoom: (roomId: string) => void
}

function trackSource(user: SocialUser) {
  const track = user.currentTrack
  return track ? { key: track.id, position: track.position, duration: track.duration, isPlaying: track.isPlaying } : undefined
}

function handleLine(user: SocialUser) {
  const presence = presenceLabel(user.presence).text.toLocaleLowerCase('tr')
  return user.handle ? `${user.handle} · ${presence}` : presence
}

function RoomStrip({ room, online, onJoin }: { room: SocialRoom; online: boolean; onJoin: () => void }) {
  const member = room.viewerRole === 'listener'
  return (
    <button type="button" className="rs-room-strip rs-row" disabled={!online} onClick={onJoin}>
      <Radio aria-hidden="true" />
      <span><b>{room.title}</b> odasında · {room.memberCount}/{room.maxMembers}</span>
      <em>{member ? 'Odaya git' : 'Katıl'}</em>
    </button>
  )
}

export function joinAndOpenRoom(actions: SocialActions, room: SocialRoom, onOpenRoom: (roomId: string) => void) {
  if (canJoinRoom(room)) actions.joinRoom(room.id)
  onOpenRoom(room.id)
}

// Phone: "Şu an dinliyor" cards, then the people who are online but not
// playing, then offline people. While Ritim Social is unreachable the last
// known list stays on screen, dimmed and inert.
export function PhoneListeners({ state, actions, hub, onOpenChat, onOpenRoom }: ListProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const online = connectionTone(state.connectionStatus) === 'online'
  const groups = groupListeners(state.users, deferredQuery)
  const total = groups.listening.length + groups.online.length + groups.offline.length

  if (!online) {
    const known = state.users.filter((user) => user.currentTrack)
    return (
      <div className="rs-list-body">
        <div className="rs-section-head"><h2>Son bilinen</h2>{state.lastOnlineAt ? <span>{clockLabel(state.lastOnlineAt)} itibarıyla</span> : null}</div>
        {known.length ? (
          <div className="rs-stack is-stale" aria-disabled="true">
            {known.map((user) => (
              <article key={user.id} className="rs-card rs-person-compact">
                <Avatar user={user} presence={false} />
                <div className="rs-person-copy"><b>{user.displayName}</b><span>{user.currentTrack?.title} · {user.currentTrack?.artist}</span></div>
                <button type="button" className="rs-round-button is-heart" disabled aria-label={`${dative(user.displayName)} kalp gönder`}><Heart /></button>
                <button type="button" className="rs-round-button" disabled aria-label={`${user.displayName} ile mesajlaş`}><MessageCircle /></button>
              </article>
            ))}
          </div>
        ) : <EmptyState title="Son bilinen dinleyici yok">Bağlantı gelince kimin ne dinlediği burada görünür.</EmptyState>}
      </div>
    )
  }

  return (
    <div className="rs-list-body">
      <label className="rs-search">
        <Search aria-hidden="true" />
        <span className="rs-sr">Kişi veya şarkı ara</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Kişi veya şarkı ara" />
      </label>

      {groups.listening.length ? (
        <>
          <div className="rs-section-head"><h2>Şu an dinliyor</h2><span>{groups.listening.length} kişi</span></div>
          <div className="rs-stack">
            {groups.listening.map((user) => {
              const room = roomStripFor(state, user.id)
              const unread = state.unreadCounts[user.id] || 0
              return (
                <article key={user.id} className="rs-card rs-listener-card">
                  <div className="rs-listener-top">
                    <Avatar user={user} />
                    <div className="rs-person-copy"><b>{user.displayName}</b><span>{handleLine(user)}</span></div>
                    <button type="button" className={`rs-pill-button is-heart ${hub.hearted.has(user.id) ? 'is-sent' : ''}`} onClick={() => hub.sendHeart(user.id)} aria-label={`${dative(user.displayName)} kalp gönder, ${user.reactionCount} kalp`}>
                      <Heart aria-hidden="true" /><span>{user.reactionCount}</span>
                    </button>
                    <button type="button" className="rs-round-button" onClick={() => onOpenChat(user.id)} aria-label={unread ? `${user.displayName} ile sohbet, ${unread} okunmamış mesaj` : `${user.displayName} ile mesajlaş`}>
                      <MessageCircle aria-hidden="true" /><CountBadge count={unread} className="is-corner" />
                    </button>
                  </div>
                  {user.currentTrack ? (
                    <div className="rs-listener-track">
                      <Cover index={user.currentTrack.cover} thumbnailUrl={user.currentTrack.thumbnailUrl} className="rs-cover" label="" />
                      <div>
                        <b>{user.currentTrack.title}</b>
                        <span>{user.currentTrack.artist}</span>
                        <TrackProgress source={trackSource(user)} />
                      </div>
                    </div>
                  ) : null}
                  {room ? <RoomStrip room={room} online={online} onJoin={() => joinAndOpenRoom(actions, room, onOpenRoom)} /> : null}
                </article>
              )
            })}
          </div>
        </>
      ) : null}

      {groups.online.length ? (
        <>
          <div className="rs-section-head"><h2>Çevrimiçi</h2><span>{groups.online.length} kişi</span></div>
          <div className="rs-rows">
            {groups.online.map((user) => <IdleRow key={user.id} state={state} user={user} onOpenChat={onOpenChat} />)}
          </div>
        </>
      ) : null}

      {groups.offline.length ? (
        <>
          <div className="rs-section-head"><h2>Çevrimdışı</h2><span>{groups.offline.length} kişi</span></div>
          <div className="rs-rows is-offline">
            {groups.offline.map((user) => <IdleRow key={user.id} state={state} user={user} onOpenChat={onOpenChat} />)}
          </div>
        </>
      ) : null}

      {!total ? (
        deferredQuery.trim()
          ? <EmptyState title="Kimse bulunamadı">Başka bir ad, kullanıcı adı veya şarkı dene.</EmptyState>
          : <EmptyState title="Henüz başka kullanıcı yok">Başka bir Ritim hesabı bağlandığında burada görünecek.</EmptyState>
      ) : null}
    </div>
  )
}

function IdleRow({ state, user, onOpenChat }: { state: SocialState; user: SocialUser; onOpenChat: (userId: string) => void }) {
  const request = requestWith(state, user.id, 'incoming')
  const unread = state.unreadCounts[user.id] || 0
  return (
    <div className="rs-idle-row">
      <Avatar user={user} />
      <div className="rs-person-copy"><b>{user.displayName}</b><span>{idleActivityLine(user)}</span></div>
      {request ? (
        <button type="button" className="rs-pill-button is-request" onClick={() => onOpenChat(user.id)}>İsteği gör</button>
      ) : (
        <button type="button" className="rs-round-button" onClick={() => onOpenChat(user.id)} aria-label={unread ? `${user.displayName} ile sohbet, ${unread} okunmamış mesaj` : `${user.displayName} ile mesajlaş`}>
          <MessageCircle aria-hidden="true" /><CountBadge count={unread} className="is-corner" />
        </button>
      )}
    </div>
  )
}

// PC list column: selectable rows; the detail column shows the profile.
export function DesktopListenersList({ state, selectedId, onSelect }: { state: SocialState; selectedId?: string; onSelect: (userId: string) => void }) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const online = connectionTone(state.connectionStatus) === 'online'
  const groups = groupListeners(state.users, deferredQuery)
  const total = groups.listening.length + groups.online.length + groups.offline.length
  const row = (user: SocialUser, listening: boolean) => {
    const unread = state.unreadCounts[user.id] || 0
    const room = roomStripFor(state, user.id)
    const request = requestWith(state, user.id, 'incoming')
    return (
      <button key={user.id} type="button" className={`rs-select-row rs-row ${selectedId === user.id ? 'is-selected' : ''}`} aria-pressed={selectedId === user.id} onClick={() => onSelect(user.id)}>
        <Avatar user={user} size={42} />
        <span className="rs-person-copy">
          <b>{user.displayName}</b>
          {listening && user.currentTrack ? (
            <span className="rs-inline-track"><Cover index={user.currentTrack.cover} thumbnailUrl={user.currentTrack.thumbnailUrl} className="rs-cover is-tiny" label="" />{user.currentTrack.title} · {user.currentTrack.artist}</span>
          ) : <span>{idleActivityLine(user)}</span>}
        </span>
        {room ? <span className="rs-tag is-room">ODA</span> : null}
        {request ? <span className="rs-tag is-request">İSTEK</span> : null}
        <CountBadge count={unread} />
      </button>
    )
  }
  return (
    <div className={`rs-list-body ${online ? '' : 'is-stale'}`}>
      <label className="rs-search">
        <Search aria-hidden="true" />
        <span className="rs-sr">Kişi veya şarkı ara</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Kişi veya şarkı ara" />
      </label>
      {groups.listening.length ? <><h3 className="rs-group-title">Şu an dinliyor · {groups.listening.length}</h3><div className="rs-select-list">{groups.listening.map((user) => row(user, true))}</div></> : null}
      {groups.online.length ? <><h3 className="rs-group-title">Çevrimiçi · {groups.online.length}</h3><div className="rs-select-list">{groups.online.map((user) => row(user, false))}</div></> : null}
      {groups.offline.length ? <><h3 className="rs-group-title">{online ? 'Çevrimdışı' : 'Son bilinen'} · {groups.offline.length}</h3><div className="rs-select-list is-offline">{groups.offline.map((user) => row(user, Boolean(!online && user.currentTrack)))}</div></> : null}
      {!total ? (
        deferredQuery.trim()
          ? <EmptyState title="Kimse bulunamadı">Başka bir ad, kullanıcı adı veya şarkı dene.</EmptyState>
          : <EmptyState title="Henüz başka kullanıcı yok">Başka bir Ritim hesabı bağlandığında burada görünecek.</EmptyState>
      ) : null}
    </div>
  )
}

export function DesktopProfilePanel({ state, actions, hub, userId, onOpenChat, onOpenRoom }: ListProps & { userId: string }) {
  const user = userFor(state, userId)
  const online = connectionTone(state.connectionStatus) === 'online'
  const [reportOpen, setReportOpen] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)
  const track = user.currentTrack
  const room = roomStripFor(state, userId)
  const request = requestWith(state, userId, 'incoming')
  const muted = state.mutedUserIds.includes(userId)
  const presence = presenceLabel(user.presence)
  const lastIncomingId = [...(state.conversations[userId] || [])].reverse().find((message) => message.senderId === userId)?.id
  return (
    <div className={`rs-profile ${online ? '' : 'is-stale'}`}>
      <div className="rs-profile-head">
        <Avatar user={user} size={84} />
        <div>
          <h2>{user.displayName}</h2>
          <p>{user.handle ? `${user.handle} · ` : ''}{presence.text}</p>
        </div>
      </div>
      {track?.title ? (
        <div className="rs-now-card">
          <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="rs-cover" label="" />
          <div>
            <small>{track.isPlaying && user.presence !== 'offline' ? 'Şu an dinliyor' : user.presence === 'offline' ? 'Son dinlediği' : 'Duraklattı'}</small>
            <b>{track.title}</b>
            <span>{track.artist}</span>
            <TrackProgress source={trackSource(user)} withTimes />
          </div>
        </div>
      ) : <div className="rs-now-empty">Şu anda bir şey dinlemiyor.</div>}
      {room ? (
        <button type="button" className="rs-room-card-link rs-row" disabled={!online} onClick={() => joinAndOpenRoom(actions, room, onOpenRoom)}>
          <Radio aria-hidden="true" />
          <span><b>{room.title} odasında</b><small>{room.memberCount}/{room.maxMembers} kişi · katılınca müzik senin bilgisayarında da çalar</small></span>
          <em>{room.viewerRole === 'listener' ? 'Odaya git' : 'Odaya katıl'}</em>
        </button>
      ) : null}
      <div className="rs-profile-actions">
        <button type="button" className="rs-button is-outline" onClick={() => onOpenChat(userId)}><MessageCircle aria-hidden="true" />{request ? 'Mesaj isteğini gör' : 'Mesaj gönder'}</button>
        <button type="button" className={`rs-button is-outline is-heart ${hub.hearted.has(userId) ? 'is-sent' : ''}`} disabled={!online} onClick={() => hub.sendHeart(userId)}><Heart aria-hidden="true" />Kalp gönder · {user.reactionCount}</button>
      </div>
      <div className="rs-profile-moderation">
        <button type="button" disabled={!online} onClick={() => actions.toggleMute(userId)}>{muted ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}{muted ? 'Sesi aç' : 'Sessize al'}</button>
        <button type="button" disabled={!online} onClick={() => setReportOpen(true)}><Flag aria-hidden="true" />Şikâyet et</button>
        <button type="button" className="is-danger" disabled={!online} onClick={() => setBlockOpen(true)}><Ban aria-hidden="true" />Engelle</button>
      </div>
      <ReportSheet open={reportOpen} name={user.displayName} desktop onClose={() => setReportOpen(false)} onSubmit={(reason, detail) => hub.reportUser(userId, reason, detail, lastIncomingId)} />
      <BlockSheet open={blockOpen} name={user.displayName} desktop onClose={() => setBlockOpen(false)} onConfirm={() => { actions.blockUser(userId); setBlockOpen(false); hub.showToast('success', `${user.displayName} engellendi.`) }} />
    </div>
  )
}
