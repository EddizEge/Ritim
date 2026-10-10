import { SOCIAL_MESSAGE_MAX_LENGTH } from './socialShared'
import type { SocialMessage, SocialSendResult } from './types'

// Optimistic direct messages. Your message becomes a bubble at once
// ("Gönderiliyor…"), turns into "İletildi" on the gateway's ack and stays on
// screen as "Gönderilemedi · Tekrar dene" if sending fails. A retry reuses the
// same clientMessageId, which the gateway deduplicates (it also becomes the
// stored message id), so the text is never lost and never sent twice.

export type OutboxStatus = 'sending' | 'sent' | 'failed'

export type OutboxEntry = {
  clientMessageId: string
  userId: string
  text: string
  createdAt: number
  status: OutboxStatus
  code?: string
  attempts: number
}

export type OutboxSender = (userId: string, text: string, clientMessageId: string) => Promise<SocialSendResult>

type Options = {
  send: OutboxSender
  now?: () => number
  newId?: () => string
  limit?: number
}

export function createSocialOutbox(options: Options) {
  const now = options.now || (() => Date.now())
  const newId = options.newId || (() => crypto.randomUUID())
  const limit = options.limit || 50
  let sender = options.send
  let entries: OutboxEntry[] = []
  const listeners = new Set<() => void>()

  function set(next: OutboxEntry[]) {
    entries = next
    for (const listener of listeners) listener()
  }

  function patch(clientMessageId: string, update: (entry: OutboxEntry) => OutboxEntry) {
    let changed = false
    const next = entries.map((entry) => {
      if (entry.clientMessageId !== clientMessageId) return entry
      const updated = update(entry)
      changed ||= updated !== entry
      return updated
    })
    if (changed) set(next)
  }

  async function attempt(entry: OutboxEntry) {
    let result: SocialSendResult
    try {
      result = await sender(entry.userId, entry.text, entry.clientMessageId)
    } catch {
      result = { ok: false, code: 'failed' }
    }
    patch(entry.clientMessageId, (current) => current.status !== 'sending' || current.attempts !== entry.attempts
      ? current
      : { ...current, status: result?.ok ? 'sent' : 'failed', code: result?.ok ? undefined : (result?.code || 'failed') })
    return result
  }

  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setSender(next: OutboxSender) {
      sender = next
    },
    send(userId: string, text: string) {
      const clean = text.trim().slice(0, SOCIAL_MESSAGE_MAX_LENGTH)
      if (!userId || !clean) return null
      const entry: OutboxEntry = { clientMessageId: newId(), userId, text: clean, createdAt: now(), status: 'sending', attempts: 1 }
      // Old delivered entries make room first; failed ones are kept.
      const kept = entries.length >= limit ? entries.filter((item) => item.status === 'failed').slice(-(limit - 1)) : entries
      set([...kept, entry])
      void attempt(entry)
      return entry
    },
    retry(clientMessageId: string) {
      const entry = entries.find((item) => item.clientMessageId === clientMessageId)
      if (!entry || entry.status !== 'failed') return false
      const retried: OutboxEntry = { ...entry, status: 'sending', code: undefined, attempts: entry.attempts + 1 }
      patch(clientMessageId, () => retried)
      void attempt(retried)
      return true
    },
    // Drops entries the gateway snapshot already contains (message id ==
    // clientMessageId), whatever their local status was.
    reconcile(conversations: Record<string, SocialMessage[]> | undefined) {
      if (!entries.length) return
      const delivered = deliveredIds(conversations)
      const next = entries.filter((entry) => !delivered.has(entry.clientMessageId))
      if (next.length !== entries.length) set(next)
    },
    clear() {
      if (entries.length) set([])
    },
  }
}

export type SocialOutbox = ReturnType<typeof createSocialOutbox>

export function deliveredIds(conversations: Record<string, SocialMessage[]> | undefined) {
  const ids = new Set<string>()
  for (const messages of Object.values(conversations || {})) {
    for (const message of messages || []) ids.add(message.id)
  }
  return ids
}

// Entries still to be drawn for one conversation (not yet in the snapshot).
export function pendingEntriesFor(entries: OutboxEntry[], userId: string, conversation: SocialMessage[] | undefined) {
  const delivered = new Set((conversation || []).map((message) => message.id))
  return entries.filter((entry) => entry.userId === userId && !delivered.has(entry.clientMessageId))
}

export function outboxStatusText(entry: OutboxEntry) {
  if (entry.status === 'sending') return 'Gönderiliyor…'
  if (entry.status === 'sent') return 'şimdi · İletildi'
  return 'Gönderilemedi'
}
