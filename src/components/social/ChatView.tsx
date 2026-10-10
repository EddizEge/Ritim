import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, Ban, Check, Clock, Flag, Heart, Mail, MessageCircle, MoreVertical, Send, Trash2, Volume2, VolumeX } from 'lucide-react'
import { SOCIAL_MESSAGE_MAX_LENGTH } from '../../social/socialShared'
import { outboxStatusText, pendingEntriesFor, type OutboxEntry } from '../../social/socialOutbox'
import {
  MESSAGE_REACTIONS,
  REACTION_NAMES,
  accusative,
  clockLabel,
  connectionTone,
  dative,
  dayLabel,
  findUser,
  firstName,
  placeholderUser,
  possessive,
  presenceLabel,
  requestWith,
  sendFailureReason,
} from '../../social/socialModel'
import type { SocialActions, SocialMessage, SocialMessageReaction, SocialState, SocialUser } from '../../social/types'
import { Cover } from '../Cover'
import { Avatar, TrackProgress } from './primitives'
import { BlockSheet, Popover, ReportSheet } from './Sheet'
import type { SocialHubModel } from './useSocialHub'

type ChatProps = {
  state: SocialState
  actions: SocialActions
  hub: SocialHubModel
  userId: string
  desktop: boolean
  onBack?: () => void
}

type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: SocialMessage; own: boolean; meta?: string; fresh: boolean; synthetic: boolean }
  | { kind: 'pending'; key: string; entry: OutboxEntry }

const GROUP_GAP_MS = 5 * 60_000

function sameDay(left: number, right: number) {
  return new Date(left).toDateString() === new Date(right).toDateString()
}

// Keeps the last known profile of the person: a conversation stays readable
// after they go offline, block or are blocked.
function useChatPartner(state: SocialState, userId: string) {
  const found = findUser(state, userId)
  const lastRef = useRef<SocialUser | undefined>(found)
  if (found) lastRef.current = found
  return lastRef.current || placeholderUser(userId)
}

function reactionSummary(reactions: SocialMessageReaction[]) {
  const counts = new Map<string, number>()
  for (const item of reactions) counts.set(item.reaction, (counts.get(item.reaction) || 0) + 1)
  return [...counts.entries()].map(([emoji, count]) => (count > 1 ? `${emoji} ${count}` : emoji)).join('  ')
}

export function ChatView({ state, actions, hub, userId, desktop, onBack }: ChatProps) {
  const user = useChatPartner(state, userId)
  const name = user.displayName
  const shortName = firstName(name)
  const conversation = state.conversations[userId] || []
  const incoming = requestWith(state, userId, 'incoming')
  const outgoing = requestWith(state, userId, 'outgoing')
  const muted = state.mutedUserIds.includes(userId)
  const online = connectionTone(state.connectionStatus) === 'online'
  const unread = state.unreadCounts[userId] || 0
  const newestMessageId = conversation.at(-1)?.id || ''
  const [menuOpen, setMenuOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockedHere, setBlocked] = useState(false)
  const [rejected, setRejected] = useState(false)
  const [acceptedNotice, setAcceptedNotice] = useState<'' | 'incoming' | 'outgoing'>('')
  const [pickerFor, setPickerFor] = useState('')
  const [knownIds] = useState(() => new Set(conversation.map((message) => message.id)))
  const threadRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const draft = hub.drafts[userId] || ''
  const pendingRequest = Boolean(incoming) && acceptedNotice !== 'incoming'
  // Blocked here, or earlier (Ayarlar › Güvenlik lists them): no composer.
  const blocked = blockedHere || state.blockedUsers.some((item) => item.id === userId)

  useEffect(() => {
    if (unread && newestMessageId && !pendingRequest) actions.markConversationRead(userId)
  }, [actions, newestMessageId, pendingRequest, unread, userId])

  // An outgoing request that disappears while its conversation stays means
  // the other person accepted it.
  const outgoingRef = useRef(Boolean(outgoing))
  useEffect(() => {
    if (outgoingRef.current && !outgoing && conversation.length) setAcceptedNotice('outgoing')
    outgoingRef.current = Boolean(outgoing)
  }, [conversation.length, outgoing])

  const pending = pendingEntriesFor(hub.outbox.entries, userId, conversation)

  const rows = useMemo(() => {
    // A pending request always has its first message; if the snapshot did
    // not carry it, the request preview stands in for it.
    const messages: Array<SocialMessage & { synthetic?: boolean }> = conversation.length || !incoming
      ? conversation
      : [{ id: `request:${userId}`, senderId: userId, text: incoming.preview, sentAt: incoming.sentAt, reactions: [], synthetic: true }]
    const result: ThreadRow[] = []
    const now = Date.now()
    const lastOwnId = [...messages].reverse().find((message) => message.senderId !== userId)?.id
    messages.forEach((message, index) => {
      const previous = messages[index - 1]
      const next = messages[index + 1]
      if (!previous || !sameDay(previous.sentAt, message.sentAt)) {
        result.push({ kind: 'day', key: `day:${message.id}`, label: dayLabel(message.sentAt, now) })
      }
      const own = message.senderId !== userId
      const endsGroup = !next || next.senderId !== message.senderId || !sameDay(next.sentAt, message.sentAt) || next.sentAt - message.sentAt > GROUP_GAP_MS
      const meta = endsGroup || message.id === lastOwnId
        ? (own && message.id === lastOwnId && !pending.length ? `${clockLabel(message.sentAt)} · İletildi` : clockLabel(message.sentAt))
        : undefined
      result.push({ kind: 'message', key: message.id, message, own, meta, fresh: !own && !knownIds.has(message.id), synthetic: Boolean(message.synthetic) })
    })
    if (pending.length && (!messages.length || !sameDay(messages.at(-1)!.sentAt, pending[0].createdAt))) {
      result.push({ kind: 'day', key: `day:pending:${pending[0].clientMessageId}`, label: dayLabel(pending[0].createdAt, now) })
    }
    for (const entry of pending) result.push({ kind: 'pending', key: entry.clientMessageId, entry })
    return result
  }, [conversation, incoming, knownIds, pending, userId])

  useLayoutEffect(() => {
    const thread = threadRef.current
    if (thread && stickRef.current) thread.scrollTop = thread.scrollHeight
  }, [rows.length, acceptedNotice])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || !online) return
    if (hub.outbox.send(userId, draft)) {
      hub.setDraft(userId, '')
      stickRef.current = true
    }
    inputRef.current?.focus()
  }

  // The store shows the reaction at once and puts it back if the gateway
  // refuses it (src/social/socialAckActions.ts).
  const react = (message: SocialMessage, reaction: SocialMessageReaction['reaction']) => {
    void actions.reactToMessage(userId, message.id, reaction)
    setPickerFor('')
  }

  // The panel answers at once; a refused or unanswered response brings the
  // request back (the store shows why).
  const respond = (action: 'accept' | 'reject') => {
    if (action === 'reject') setRejected(true)
    else setAcceptedNotice('incoming')
    void actions.respondToMessageRequest(userId, action).then((result) => {
      if (result.ok) return
      if (action === 'reject') setRejected(false)
      else setAcceptedNotice((current) => (current === 'incoming' ? '' : current))
    })
  }

  const lastIncomingId = [...conversation].reverse().find((message) => message.senderId === userId)?.id
  const subtitle = rejected
    ? { text: 'İstek reddedildi', tone: 'request' }
    : pendingRequest
      ? { text: 'Mesaj isteği', tone: 'request' }
      : outgoing
        ? { text: 'İsteğin yanıt bekliyor', tone: 'offline' }
        : presenceLabel(user.presence)
  const track = user.currentTrack
  const showTrack = Boolean(track && !pendingRequest && !blocked && !rejected)

  const moderation = (
    <>
      <ReportSheet
        open={reportOpen}
        name={name}
        desktop={desktop}
        onClose={() => setReportOpen(false)}
        onSubmit={(reason, detail) => hub.reportUser(userId, reason, detail, lastIncomingId)}
      />
      <BlockSheet
        open={blockOpen}
        name={name}
        desktop={desktop}
        onClose={() => setBlockOpen(false)}
        onConfirm={() => {
          setBlockOpen(false)
          setBlocked(true)
          // Refused or unanswered: the chat comes back (the store shows why).
          void actions.blockUser(userId).then((result) => {
            if (!result.ok) setBlocked(false)
          })
        }}
      />
    </>
  )

  if (blocked || rejected) {
    return (
      <section className={`rs-chat ${desktop ? 'is-desktop' : 'rs-screen'}`} aria-label={`${name} ile sohbet`}>
        <ChatHeader user={user} name={name} muted={muted} subtitle={subtitle} desktop={desktop} onBack={onBack} />
        <div className="rs-chat-result">
          {blocked ? <Ban aria-hidden="true" className="is-danger" /> : <Trash2 aria-hidden="true" />}
          <b>{blocked ? `${name} engellendi` : 'İstek reddedildi'}</b>
          <p>{blocked ? 'Engeli Ayarlar › Güvenlik › Engellenenler bölümünden kaldırabilirsin.' : `${possessive(name)} isteği ve mesajları silindi.`}</p>
          {onBack && !desktop ? <button type="button" className="rs-button is-secondary" onClick={onBack}>Mesajlara dön</button> : null}
        </div>
      </section>
    )
  }

  return (
    <section className={`rs-chat ${desktop ? 'is-desktop' : 'rs-screen'}`} aria-label={`${name} ile sohbet`}>
      <ChatHeader user={user} name={name} muted={muted} subtitle={subtitle} desktop={desktop} onBack={onBack}>
        {/* A pending request answers from its own panel (Şikâyet et · Engelle). */}
        {pendingRequest ? null : desktop ? (
          <>
            <button type="button" className="rs-icon-button" disabled={!online} onClick={() => actions.toggleMute(userId)} aria-label={muted ? 'Sesi aç' : 'Sessize al'} title={muted ? 'Sesi aç' : 'Sessize al'}>{muted ? <Volume2 /> : <VolumeX />}</button>
            <button type="button" className="rs-icon-button" disabled={!online} onClick={() => setReportOpen(true)} aria-label={`${accusative(name)} şikâyet et`} title="Şikâyet et"><Flag /></button>
            <button type="button" className="rs-icon-button is-danger" disabled={!online} onClick={() => setBlockOpen(true)} aria-label={`${accusative(name)} engelle`} title="Engelle"><Ban /></button>
          </>
        ) : (
          <div className="rs-menu-anchor">
            <button type="button" className="rs-icon-button" onClick={() => setMenuOpen((value) => !value)} aria-label="Sohbet seçenekleri" aria-expanded={menuOpen} aria-haspopup="menu"><MoreVertical /></button>
            <Popover open={menuOpen} onClose={() => setMenuOpen(false)} label="Sohbet seçenekleri" className="is-top-right">
              <button type="button" role="menuitem" disabled={!online} onClick={() => { actions.toggleMute(userId); setMenuOpen(false) }}>{muted ? <Volume2 /> : <VolumeX />}{muted ? 'Sesi aç' : 'Sessize al'}</button>
              <button type="button" role="menuitem" disabled={!online} onClick={() => { setMenuOpen(false); setReportOpen(true) }}><Flag />Şikâyet et</button>
              <button type="button" role="menuitem" className="is-danger" disabled={!online} onClick={() => { setMenuOpen(false); setBlockOpen(true) }}><Ban />Engelle</button>
            </Popover>
          </div>
        )}
      </ChatHeader>

      {showTrack && track ? (
        <div className="rs-chat-track">
          <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="rs-cover" label="" />
          <div className="rs-chat-track-copy">
            <small>{shortName} {track.isPlaying ? 'şu an dinliyor' : 'duraklattı'}</small>
            <b>{track.title}{track.artist ? <span> · {track.artist}</span> : null}</b>
            <TrackProgress source={{ key: track.id, position: track.position, duration: track.duration, isPlaying: track.isPlaying }} />
          </div>
          <button
            type="button"
            className={`rs-heart-button ${hub.hearted.has(userId) ? 'is-sent' : ''} ${desktop ? 'has-label' : ''}`}
            disabled={!online}
            onClick={() => hub.sendHeart(userId)}
            aria-label={`${dative(name)} kalp gönder`}
          >
            <Heart aria-hidden="true" />{desktop ? 'Kalp gönder' : null}
          </button>
        </div>
      ) : null}

      <div
        ref={threadRef}
        className={`rs-thread ${online ? '' : 'is-stale'}`}
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        {pendingRequest ? (
          <div className="rs-request-intro">
            <Avatar user={user} size={desktop ? 72 : 76} presence={false} />
            <b>{name}</b>
            {user.handle ? <span>{user.handle}</span> : null}
            {track?.title ? (
              <div className="rs-activity-pill">
                <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="rs-cover" label="" />
                <span>{track.isPlaying ? 'Dinliyor' : 'Duraklattı'} · {track.title}{track.artist ? ` — ${track.artist}` : ''}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="rs-thread-spacer" />
        {rows.length === 0 && !pendingRequest ? (
          <div className="rs-thread-empty">
            <MessageCircle aria-hidden="true" />
            <b>{outgoing ? 'İsteğin gönderildi' : 'İlk mesajı sen gönder'}</b>
            <p>{outgoing ? `${shortName} kabul edince yazışabilirsiniz.` : 'İlk mesajın bir mesaj isteği olarak gider; kabul edilince yazışabilirsiniz.'}</p>
          </div>
        ) : null}
        {rows.map((row) => {
          if (row.kind === 'day') return <div key={row.key} className="rs-day">{row.label}</div>
          if (row.kind === 'pending') return <PendingBubble key={row.key} entry={row.entry} desktop={desktop} onRetry={() => hub.outbox.retry(row.entry.clientMessageId)} canRetry={online} />
          const { message, own } = row
          const reactable = !row.synthetic && online && !pendingRequest
          const picker = reactable ? (
            <div className={`rs-picker ${desktop ? 'is-hover' : ''}`} role="group" aria-label="Tepki ver">
              {MESSAGE_REACTIONS.map((reaction) => {
                const selected = message.reactions.some((item) => item.actorId === state.currentUser.id && item.reaction === reaction)
                return (
                  <button key={reaction} type="button" aria-pressed={selected} className={selected ? 'is-selected' : ''} aria-label={`${REACTION_NAMES[reaction]} tepkisi ver`} onClick={() => react(message, reaction)}>{reaction}</button>
                )
              })}
            </div>
          ) : null
          return (
            <Fragment key={row.key}>
              <div className={`rs-message ${own ? 'is-own' : 'is-incoming'} ${row.fresh ? 'is-fresh' : ''}`}>
                <div className="rs-message-line">
                  {desktop ? (
                    <div className="rs-bubble">{message.text}</div>
                  ) : (
                    <button
                      type="button"
                      className="rs-bubble"
                      disabled={!reactable}
                      aria-expanded={reactable ? pickerFor === message.id : undefined}
                      aria-label={reactable ? `Mesaja tepki ver: ${message.text}` : undefined}
                      onClick={() => setPickerFor((current) => (current === message.id ? '' : message.id))}
                    >{message.text}</button>
                  )}
                  {desktop ? picker : null}
                </div>
                {message.reactions.length ? <span className="rs-reaction-chip">{reactionSummary(message.reactions)}</span> : null}
                {!desktop && pickerFor === message.id ? picker : null}
              </div>
              {row.meta ? <span className={`rs-message-meta ${own ? 'is-own' : ''}`}>{row.meta}</span> : null}
            </Fragment>
          )
        })}
        {acceptedNotice ? (
          <div className="rs-system-row">
            <Check aria-hidden="true" />
            {acceptedNotice === 'incoming' ? 'İsteği kabul ettin · artık yazışabilirsiniz' : `${shortName} isteğini kabul etti · artık yazışabilirsiniz`}
          </div>
        ) : null}
      </div>

      {pendingRequest ? (
        <section className="rs-request-panel" aria-label="Mesaj isteği">
          <div className="rs-request-panel-copy">
            <Mail aria-hidden="true" />
            <div>
              <b>{shortName} sana yazmak istiyor</b>
              <p>Cevap yazmak için önce kabul et. Reddedersen istek ve mesajları silinir.</p>
            </div>
          </div>
          <div className="rs-request-panel-actions">
            <button type="button" className="rs-button is-request" disabled={!online} onClick={() => respond('reject')}>Reddet</button>
            <button type="button" className="rs-button is-primary" disabled={!online} onClick={() => respond('accept')}><Check aria-hidden="true" />Kabul et</button>
          </div>
          <div className="rs-request-panel-links">
            <button type="button" disabled={!online} onClick={() => setReportOpen(true)}>Şikâyet et</button>
            <span aria-hidden="true">·</span>
            <button type="button" className="is-danger" disabled={!online} onClick={() => setBlockOpen(true)}>Engelle</button>
          </div>
        </section>
      ) : outgoing ? (
        <div className="rs-chat-info"><Clock aria-hidden="true" /><span><b>Mesaj isteğin gönderildi.</b> {shortName} kabul edince yazışmaya devam edebilirsiniz.</span></div>
      ) : (
        <form className="rs-composer" onSubmit={submit}>
          <label className="rs-composer-field">
            <span className="rs-sr">Mesaj</span>
            <input
              ref={inputRef}
              value={draft}
              maxLength={SOCIAL_MESSAGE_MAX_LENGTH}
              autoComplete="off"
              placeholder={online ? `${dative(shortName)} yaz…` : 'Bağlantı gelince gönderebilirsin'}
              onChange={(event) => hub.setDraft(userId, event.target.value)}
            />
            {desktop && draft.length ? <small>{draft.length}/{SOCIAL_MESSAGE_MAX_LENGTH}</small> : null}
          </label>
          <button type="submit" className={`rs-send ${desktop ? 'has-label' : ''}`} disabled={!draft.trim() || !online} aria-label="Mesajı gönder">
            <Send aria-hidden="true" />{desktop ? 'Gönder' : null}
          </button>
        </form>
      )}
      {moderation}
    </section>
  )
}

function ChatHeader({ user, name, muted, subtitle, desktop, onBack, children }: {
  user: SocialUser
  name: string
  muted: boolean
  subtitle: { text: string; tone: string }
  desktop: boolean
  onBack?: () => void
  children?: ReactNode
}) {
  return (
    <header className="rs-chat-header">
      {!desktop && onBack ? <button type="button" className="rs-icon-button is-back" onClick={onBack} aria-label="Mesajlara dön"><ArrowLeft /></button> : null}
      <Avatar user={user} size={desktop ? 42 : 40} />
      <div className="rs-chat-title">
        <b>{name}{muted ? <VolumeX className="rs-muted-icon" role="img" aria-label="Sessize alındı" /> : null}</b>
        <span className={`is-${subtitle.tone}`}>{subtitle.text}</span>
      </div>
      {children}
    </header>
  )
}

function PendingBubble({ entry, desktop, canRetry, onRetry }: { entry: OutboxEntry; desktop: boolean; canRetry: boolean; onRetry: () => void }) {
  const failed = entry.status === 'failed'
  return (
    <>
      <div className="rs-message is-own is-pending">
        <div className="rs-message-line">
          <div className={`rs-bubble ${failed ? 'is-failed' : ''} ${entry.status === 'sending' ? 'is-sending' : ''}`}>{entry.text}</div>
        </div>
      </div>
      {failed ? (
        <div className="rs-message-failed" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{desktop ? `Gönderilemedi: ${sendFailureReason(entry.code)}` : 'Gönderilemedi'}</span>
          <button type="button" disabled={!canRetry} onClick={onRetry}>Tekrar dene</button>
        </div>
      ) : (
        <span className="rs-message-meta is-own">{outboxStatusText(entry)}</span>
      )}
    </>
  )
}
