import { SOCIAL_MESSAGE_MAX_LENGTH } from './socialShared'
import type { SocialMessage, SocialSendResult } from './types'

// Optimistic direct messages. Your message becomes a bubble at once
// ("Gönderiliyor…"), turns into "İletildi" on the gateway's ack and stays on
// screen as "Gönderilemedi · Tekrar dene" if sending fails. A retry reuses the
// same clientMessageId, which the gateway deduplicates (it also becomes the
// stored message id), so the text is never lost and never sent twice.
//
// Unsent messages (still sending or failed) are kept in local storage, one
// key per Ritim account, so they survive a restart of the phone app or the PC
// Social view. After a restart they come back as "Gönderilemedi" and are only
// sent again when you tap "Tekrar dene".

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

export type OutboxStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

type Options = {
  send: OutboxSender
  now?: () => number
  newId?: () => string
  limit?: number
  // Persistence; none keeps the outbox in memory only.
  storage?: OutboxStorage | null
  maxAgeMs?: number
  // Account whose unsent messages are shown (and stored).
  account?: string
}

export const SOCIAL_OUTBOX_KEY_PREFIX = 'ritim.social.outbox.v1:'
export const SOCIAL_OUTBOX_LIMIT = 50
export const SOCIAL_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ID_LENGTH = 200

export function socialOutboxKey(account: string) {
  return `${SOCIAL_OUTBOX_KEY_PREFIX}${account}`
}

export function createSocialOutbox(options: Options) {
  const now = options.now || (() => Date.now())
  const newId = options.newId || (() => crypto.randomUUID())
  const limit = options.limit || SOCIAL_OUTBOX_LIMIT
  const maxAgeMs = options.maxAgeMs || SOCIAL_OUTBOX_MAX_AGE_MS
  const storage = options.storage || null
  let sender = options.send
  let account = ''
  let entries: OutboxEntry[] = []
  const listeners = new Set<() => void>()

  function emit() {
    for (const listener of listeners) listener()
  }

  function set(next: OutboxEntry[]) {
    entries = next
    store(account, next)
    emit()
  }

  function store(owner: string, list: OutboxEntry[]) {
    if (!storage || !owner) return
    writeStoredEntries(storage, owner, list, { now: now(), limit, maxAgeMs })
  }

  function patch(owner: string, clientMessageId: string, update: (entry: OutboxEntry) => OutboxEntry) {
    // An answer can arrive after another account signed in; it then belongs
    // to the stored outbox of the account that sent it.
    const current = owner === account
    const list = current ? entries : readStoredEntries(storage, owner, { now: now(), limit, maxAgeMs, restored: false })
    let changed = false
    const next = list.map((entry) => {
      if (entry.clientMessageId !== clientMessageId) return entry
      const updated = update(entry)
      changed ||= updated !== entry
      return updated
    })
    if (!changed) return
    if (current) set(next)
    else store(owner, next)
  }

  async function attempt(owner: string, entry: OutboxEntry) {
    let result: SocialSendResult
    try {
      result = await sender(entry.userId, entry.text, entry.clientMessageId)
    } catch {
      result = { ok: false, code: 'failed' }
    }
    patch(owner, entry.clientMessageId, (current) => current.status !== 'sending' || current.attempts !== entry.attempts
      ? current
      : { ...current, status: result?.ok ? 'sent' : 'failed', code: result?.ok ? undefined : (result?.code || 'failed') })
    return result
  }

  function setAccount(next: string) {
    const id = String(next || '')
    if (id === account) return
    account = id
    entries = readStoredEntries(storage, id, { now: now(), limit, maxAgeMs, restored: true })
    emit()
  }

  if (options.account) setAccount(options.account)

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
    // Shows the given account's unsent messages; the previous account's stay
    // in its own storage key.
    setAccount,
    getAccount: () => account,
    send(userId: string, text: string) {
      const clean = text.trim().slice(0, SOCIAL_MESSAGE_MAX_LENGTH)
      if (!userId || !clean) return null
      const entry: OutboxEntry = { clientMessageId: newId(), userId, text: clean, createdAt: now(), status: 'sending', attempts: 1 }
      set([...withRoomFor(entries, limit), entry])
      void attempt(account, entry)
      return entry
    },
    retry(clientMessageId: string) {
      const entry = entries.find((item) => item.clientMessageId === clientMessageId)
      if (!entry || entry.status !== 'failed') return false
      const retried: OutboxEntry = { ...entry, status: 'sending', code: undefined, attempts: entry.attempts + 1 }
      patch(account, clientMessageId, () => retried)
      void attempt(account, retried)
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
    // Sign-out: the account's unsent messages are removed from this device.
    forget(accountId = account) {
      if (storage && accountId) safely(() => storage.removeItem(socialOutboxKey(accountId)))
      if (accountId === account && entries.length) {
        entries = []
        emit()
      }
    },
    clear() {
      if (storage && account) safely(() => storage.removeItem(socialOutboxKey(account)))
      if (entries.length) {
        entries = []
        emit()
      }
    },
  }
}

export type SocialOutbox = ReturnType<typeof createSocialOutbox>

// Old delivered bubbles make room first; unsent ones go only when nothing
// else is left, oldest first.
function withRoomFor(list: OutboxEntry[], limit: number) {
  if (list.length < limit) return list
  const unsent = list.filter((item) => item.status !== 'sent')
  return unsent.slice(Math.max(0, unsent.length - (limit - 1)))
}

function safely<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

type StoreLimits = { now: number; limit: number; maxAgeMs: number }

// Older than a week (or dated implausibly far ahead) is dropped.
function fresh(entry: OutboxEntry, { now, maxAgeMs }: Pick<StoreLimits, 'now' | 'maxAgeMs'>) {
  return entry.createdAt > now - maxAgeMs && entry.createdAt < now + maxAgeMs
}

function writeStoredEntries(storage: OutboxStorage, account: string, list: OutboxEntry[], limits: StoreLimits) {
  // Delivered messages are in the gateway's history; only unsent ones are kept.
  const kept = list
    .filter((entry) => entry.status !== 'sent' && fresh(entry, limits))
    .slice(-limits.limit)
    .map(({ clientMessageId, userId, text, createdAt, status, code, attempts }) => ({ clientMessageId, userId, text, createdAt, status, code, attempts }))
  const key = socialOutboxKey(account)
  safely(() => {
    if (kept.length) storage.setItem(key, JSON.stringify({ version: 1, entries: kept }))
    else storage.removeItem(key)
  })
}

// Reads one account's stored outbox. Anything malformed is skipped (and a
// record that is not readable at all is removed); it never throws.
export function readStoredEntries(
  storage: OutboxStorage | null,
  account: string,
  { now, limit, maxAgeMs, restored }: StoreLimits & { restored: boolean },
): OutboxEntry[] {
  if (!storage || !account) return []
  const key = socialOutboxKey(account)
  const raw = safely(() => storage.getItem(key))
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safely(() => storage.removeItem(key))
    return []
  }
  const items = parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
    ? (parsed as { entries: unknown[] }).entries
    : null
  if (!items) {
    safely(() => storage.removeItem(key))
    return []
  }
  const seen = new Set<string>()
  const result: OutboxEntry[] = []
  for (const item of items) {
    const entry = storedEntry(item)
    if (!entry || seen.has(entry.clientMessageId) || !fresh(entry, { now, maxAgeMs })) continue
    seen.add(entry.clientMessageId)
    // Nothing is sending after a restart: the bubble waits for "Tekrar dene".
    result.push(restored && entry.status === 'sending' ? { ...entry, status: 'failed', code: entry.code || 'interrupted' } : entry)
  }
  result.sort((a, b) => a.createdAt - b.createdAt)
  return result.slice(-limit)
}

function storedEntry(value: unknown): OutboxEntry | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
  if (!validId(item.clientMessageId) || !validId(item.userId)) return null
  if (typeof item.text !== 'string') return null
  const text = item.text.trim().slice(0, SOCIAL_MESSAGE_MAX_LENGTH)
  if (!text) return null
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null
  if (item.status !== 'sending' && item.status !== 'failed') return null
  const attempts = typeof item.attempts === 'number' && Number.isFinite(item.attempts) && item.attempts >= 1
    ? Math.min(Math.floor(item.attempts), 1_000)
    : 1
  const code = typeof item.code === 'string' && item.code.length <= 64 ? item.code : undefined
  return { clientMessageId: item.clientMessageId, userId: item.userId, text, createdAt: item.createdAt, status: item.status, code, attempts }
}

// The page's own storage (phone WebView or the PC Social view), if usable.
export function browserOutboxStorage(): OutboxStorage | null {
  try {
    return typeof window === 'undefined' || !window.localStorage ? null : window.localStorage
  } catch {
    return null
  }
}

// One outbox per page: the phone's Social tab unmounts when you switch tabs
// and a failed message must still be there (with its clientMessageId) when you
// come back.
let sharedOutbox: SocialOutbox | null = null
let sharedSend: OutboxSender | null = null

export function sharedSocialOutbox(send: OutboxSender) {
  sharedSend = send
  if (!sharedOutbox) {
    sharedOutbox = createSocialOutbox({
      send: (userId, text, clientMessageId) => sharedSend
        ? sharedSend(userId, text, clientMessageId)
        : Promise.resolve({ ok: false, code: 'offline' }),
      storage: browserOutboxStorage(),
    })
  }
  return sharedOutbox
}

// Sign-out on this device. With an account id only that account's outbox is
// removed; without one (the phone does not always know which account it was)
// every stored outbox on this device goes.
export function forgetSocialOutbox(accountId?: string, storage: OutboxStorage | null = browserOutboxStorage()) {
  if (accountId) {
    if (sharedOutbox) sharedOutbox.forget(accountId)
    else if (storage) safely(() => storage.removeItem(socialOutboxKey(accountId)))
    return
  }
  sharedOutbox?.clear()
  if (!storage) return
  const keys: string[] = []
  safely(() => {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(SOCIAL_OUTBOX_KEY_PREFIX)) keys.push(key)
    }
  })
  for (const key of keys) safely(() => storage.removeItem(key))
}

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
