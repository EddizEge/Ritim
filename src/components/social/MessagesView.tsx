import { useDeferredValue, useState } from 'react'
import { Check, Clock, Search, VolumeX, X } from 'lucide-react'
import {
  connectionTone,
  conversationSummaries,
  incomingRequests,
  normalizeQuery,
  possessive,
  relativeTimeLabel,
  type ConversationSummary,
} from '../../social/socialModel'
import type { SocialState } from '../../social/types'
import { Avatar, CountBadge, EmptyState } from './primitives'
import type { SocialHubModel } from './useSocialHub'

type MessagesProps = {
  state: SocialState
  hub: SocialHubModel
  onOpenChat: (userId: string) => void
  selectedId?: string
  desktop: boolean
}

function ConversationRow({ summary, selected, desktop, onOpen }: { summary: ConversationSummary; selected: boolean; desktop: boolean; onOpen: () => void }) {
  const unread = summary.unread > 0
  const label = [summary.user.displayName, unread ? `${summary.unread} okunmamış mesaj` : '', summary.muted ? 'sessize alındı' : ''].filter(Boolean).join(', ')
  return (
    <button type="button" className={`rs-conversation rs-row ${unread ? 'is-unread' : ''} ${selected ? 'is-selected' : ''}`} aria-current={selected ? 'true' : undefined} aria-label={label} onClick={onOpen}>
      <Avatar user={summary.user} size={desktop ? 42 : 48} />
      <span className="rs-conversation-copy">
        <span className="rs-conversation-top">
          <b>{summary.user.displayName}</b>
          {summary.muted ? <VolumeX className="rs-muted-icon" aria-hidden="true" /> : null}
          <time>{relativeTimeLabel(summary.time)}</time>
        </span>
        <span className="rs-conversation-bottom">
          {summary.outgoingPending
            ? <span className="rs-conversation-preview is-pending"><Clock aria-hidden="true" />İsteğin yanıt bekliyor</span>
            : <span className="rs-conversation-preview">{summary.preview}</span>}
          <CountBadge count={summary.unread} />
        </span>
      </span>
    </button>
  )
}

export function MessagesList({ state, hub, onOpenChat, selectedId, desktop }: MessagesProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = normalizeQuery(useDeferredValue(query))
  const online = connectionTone(state.connectionStatus) === 'online'
  const requests = incomingRequests(state).filter((request) => !hub.gone.has(`request:${request.userId}`))
  const conversations = conversationSummaries(state).filter((summary) => !deferredQuery
    || summary.user.displayName.toLocaleLowerCase('tr').includes(deferredQuery)
    || summary.preview.toLocaleLowerCase('tr').includes(deferredQuery))
  const unreadConversations = conversations.filter((summary) => summary.unread > 0).length

  return (
    <div className={`rs-list-body ${online ? '' : 'is-stale'}`}>
      {desktop ? (
        <label className="rs-search">
          <Search aria-hidden="true" />
          <span className="rs-sr">Sohbetlerde ara</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Sohbetlerde ara" />
        </label>
      ) : null}

      {requests.length ? (
        <section className={desktop ? 'rs-requests-box' : 'rs-requests'} aria-label="Mesaj istekleri">
          <div className="rs-section-head is-request"><h2>Mesaj istekleri</h2><span>{requests.length} bekliyor</span></div>
          {!desktop ? <p className="rs-hint">Kabul edince birbirinize yazabilirsiniz.</p> : null}
          <div className={desktop ? 'rs-request-rows' : 'rs-stack'}>
            {requests.map((request) => {
              const key = `request:${request.userId}`
              const owner = possessive(request.user.displayName)
              const leaving = hub.leaving.has(key)
              return desktop ? (
                <div key={key} className={`rs-request-row ${leaving ? 'is-leaving' : ''}`}>
                  <button type="button" className="rs-request-open rs-row" onClick={() => onOpenChat(request.userId)}>
                    <Avatar user={request.user} size={36} presence={false} />
                    <span className="rs-person-copy"><b>{request.user.displayName}</b><span>{request.preview}</span></span>
                  </button>
                  <button type="button" className="rs-round-button is-small" disabled={!online || leaving} title="Reddet" aria-label={`${request.user.displayName} isteğini reddet`} onClick={() => hub.respondToRequest(request.userId, owner, 'reject')}><X /></button>
                  <button type="button" className="rs-round-button is-small is-primary" disabled={!online || leaving} title="Kabul et" aria-label={`${request.user.displayName} isteğini kabul et`} onClick={() => hub.respondToRequest(request.userId, owner, 'accept')}><Check /></button>
                </div>
              ) : (
                <article key={key} className={`rs-card rs-request-card ${leaving ? 'is-leaving' : ''}`}>
                  <button type="button" className="rs-request-open rs-row" onClick={() => onOpenChat(request.userId)}>
                    <Avatar user={request.user} presence={false} />
                    <span className="rs-person-copy">
                      <span className="rs-conversation-top"><b>{request.user.displayName}</b><time>{relativeTimeLabel(request.sentAt)}</time></span>
                      <span>{request.preview}</span>
                    </span>
                  </button>
                  <div className="rs-two-buttons">
                    <button type="button" className="rs-button is-secondary" disabled={!online || leaving} onClick={() => hub.respondToRequest(request.userId, owner, 'reject')}>Reddet</button>
                    <button type="button" className="rs-button is-primary" disabled={!online || leaving} onClick={() => hub.respondToRequest(request.userId, owner, 'accept')}><Check aria-hidden="true" />Kabul et</button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      <section aria-label="Sohbetler">
        {desktop ? <h3 className="rs-group-title">Sohbetler</h3> : (
          <div className="rs-section-head"><h2>Sohbetler</h2>{unreadConversations ? <span>{unreadConversations} okunmamış</span> : null}</div>
        )}
        {conversations.length ? (
          <div className="rs-conversations">
            {conversations.map((summary) => (
              <ConversationRow key={summary.userId} summary={summary} desktop={desktop} selected={selectedId === summary.userId} onOpen={() => onOpenChat(summary.userId)} />
            ))}
          </div>
        ) : deferredQuery ? (
          <EmptyState title="Sohbet bulunamadı">Başka bir ad veya kelime dene.</EmptyState>
        ) : (
          <EmptyState title="Henüz sohbet yok">Dinleyenler’den birine yazarak başlayabilirsin.</EmptyState>
        )}
      </section>
    </div>
  )
}
