import { applySocialPending, ownReactionAfterToggle, type SocialPendingChange, type SocialPendingEntry } from './socialPending'
import {
  SOCIAL_ACK_TIMEOUT_MS,
  SOCIAL_REPORT_DETAIL_MAX_LENGTH,
  SOCIAL_REPORT_REASON_MAX_LENGTH,
  type SocialAckResult,
} from './socialShared'
import type {
  SocialActionResult,
  SocialMessageReaction,
  SocialNotificationPreferences,
  SocialPrivacy,
  SocialState,
} from './types'

// Gateway events, besides messages and room events, that answer an
// acknowledgement callback with `{ ok: true }` or `{ ok: false, code }`
// (electron/social-hub.cjs). The PC sends them by action type through
// electron/social-bridge.cjs, the phone by event name on its own socket.
export const SOCIAL_ACK_EVENTS = {
  'request-response': 'social:request-response',
  read: 'social:read',
  'message-reaction': 'social:message-reaction',
  'notifications-read': 'social:notifications-read',
  mute: 'social:mute',
  block: 'social:block',
  report: 'social:report',
  privacy: 'social:privacy',
  'notification-preferences': 'social:notification-preferences',
  listening: 'social:listening',
  'create-room': 'social:create-room',
  reaction: 'social:reaction',
} as const

export type SocialAckActionType = keyof typeof SOCIAL_ACK_EVENTS

export type SocialAckSocket = {
  connected: boolean
  emit: (event: string, ...args: unknown[]) => unknown
}

const ACK_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

// Same rules as sanitizeAckResult in electron/social-bridge.cjs.
export function normalizeSocialAck(value: unknown): SocialAckResult & { ok: boolean } {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const normalized: SocialAckResult & { ok: boolean } = { ok: result.ok === true }
  if (typeof result.code === 'string' && ACK_CODE_PATTERN.test(result.code)) normalized.code = result.code
  if (typeof result.duplicate === 'boolean') normalized.duplicate = result.duplicate
  if (result.status === 'joined' || result.status === 'left') normalized.status = result.status
  if (!normalized.ok && !normalized.code) normalized.code = 'rejected'
  return normalized
}

// The phone's counterpart of the PC bridge's emitWithAck: `offline` when the
// socket is not connected (socket.io would otherwise buffer the event and
// send it on reconnect, long after the user gave up), `timeout` when no
// answer comes in time; a late answer is ignored.
export function emitSocialAck(
  socket: SocialAckSocket,
  event: string,
  payload: Record<string, unknown> = {},
  timeoutMs = SOCIAL_ACK_TIMEOUT_MS,
): Promise<SocialAckResult & { ok: boolean }> {
  if (!socket.connected) return Promise.resolve({ ok: false, code: 'offline' })
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, code: 'timeout' })
    }, timeoutMs)
    try {
      socket.emit(event, payload, (result: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(normalizeSocialAck(result))
      })
    } catch {
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: 'offline' })
    }
  })
}

type AckActionsHost = {
  send: (type: SocialAckActionType, payload?: Record<string, unknown>) => Promise<SocialActionResult>
  // The gateway snapshot, without the pending overlay.
  getState: () => SocialState
  isOnline: () => boolean
  notifyError: (code?: string) => void
  // The overlay changed; the host re-renders with view().
  onPendingChange: () => void
  newId?: () => string
}

type RunOptions = {
  optimistic?: SocialPendingChange
  // Buttons for these are disabled while offline; a click that still gets
  // through does nothing, as before acknowledgements.
  requiresOnline?: boolean
  // Background actions (marking a conversation read) never raise a notice.
  quiet?: boolean
}

const OFFLINE: SocialActionResult = { ok: false, code: 'offline' }

// Acknowledged social actions shared by the PC store
// (src/desktopSocial/desktopSocialStore.ts) and the phone hook
// (src/hooks/useSocial.ts), so both behave the same: the optimistic change is
// shown at once, a success notice is the caller's to show once `ok` arrives,
// and a failure or timeout drops the optimistic change and shows
// socialErrorText(code) through notifyError.
export function createSocialAckActions(host: AckActionsHost) {
  const newId = host.newId || (() => crypto.randomUUID())
  let pending: SocialPendingEntry[] = []
  let cachedBase: SocialState | null = null
  let cachedPending: SocialPendingEntry[] | null = null
  let cachedView: SocialState | null = null

  function setPending(next: SocialPendingEntry[]) {
    if (next === pending) return
    pending = next
    host.onPendingChange()
  }

  // Stable for the same snapshot and overlay (useSyncExternalStore, memo).
  function view(base: SocialState = host.getState()) {
    if (base !== cachedBase || pending !== cachedPending || !cachedView) {
      cachedBase = base
      cachedPending = pending
      cachedView = applySocialPending(base, pending)
    }
    return cachedView
  }

  // A new gateway snapshot carries every acknowledged change.
  function noteSnapshot() {
    if (pending.some((entry) => entry.confirmed)) setPending(pending.filter((entry) => !entry.confirmed))
  }

  function reset() {
    if (pending.length) setPending([])
  }

  async function run(type: SocialAckActionType, payload: Record<string, unknown> | undefined, options: RunOptions = {}) {
    if (options.requiresOnline && !host.isOnline()) return OFFLINE
    let token = ''
    if (options.optimistic) {
      token = newId()
      setPending([...pending, { ...options.optimistic, token, confirmed: false }])
    }
    let result: SocialActionResult
    try {
      const answer = await host.send(type, payload)
      result = answer?.ok === true ? { ok: true } : { ok: false, code: answer?.code || 'rejected' }
    } catch {
      result = { ok: false, code: 'rejected' }
    }
    if (token) {
      setPending(result.ok
        ? pending.map((entry) => (entry.token === token ? { ...entry, confirmed: true } : entry))
        : pending.filter((entry) => entry.token !== token))
    }
    if (!result.ok && !options.quiet) host.notifyError(result.code)
    return result
  }

  const actions = {
    respondToMessageRequest(userId: string, action: 'accept' | 'reject') {
      return run('request-response', { requesterUserId: userId, action }, {
        requiresOnline: true,
        optimistic: { kind: 'request-response', userId },
      })
    },
    reactToMessage(userId: string, messageId: string, reaction: SocialMessageReaction['reaction']) {
      return run('message-reaction', { targetUserId: userId, messageId, reaction }, {
        requiresOnline: true,
        optimistic: { kind: 'message-reaction', userId, messageId, reaction: ownReactionAfterToggle(view(), userId, messageId, reaction) },
      })
    },
    markNotificationsRead() {
      const ids = view().notifications.filter((notification) => !notification.read).map((notification) => notification.id)
      return run('notifications-read', undefined, {
        requiresOnline: true,
        optimistic: ids.length ? { kind: 'notifications-read', ids } : undefined,
      })
    },
    markConversationRead(userId: string) {
      return run('read', { targetUserId: userId }, { requiresOnline: true, quiet: true })
    },
    toggleMute(userId: string) {
      return run('mute', { targetUserId: userId }, { requiresOnline: true })
    },
    reportUser(userId: string, reason: string, detail = '', messageId = '') {
      return run('report', {
        targetUserId: userId,
        reason: reason.trim().slice(0, SOCIAL_REPORT_REASON_MAX_LENGTH),
        detail: detail.trim().slice(0, SOCIAL_REPORT_DETAIL_MAX_LENGTH),
        messageId: messageId || '',
      }, { requiresOnline: true })
    },
    reactToUser(userId: string, reaction = '♥') {
      return run('reaction', { targetUserId: userId, reaction })
    },
    blockUser(userId: string) {
      return run('block', { targetUserId: userId })
    },
    updatePrivacy(privacy: SocialPrivacy) {
      return run('privacy', { ...privacy }, { optimistic: { kind: 'privacy', privacy } })
    },
    // Only the account-wide switches go to the gateway; this device's system
    // notification switch stays with the host.
    updateNotificationPreferences(preferences: Pick<SocialNotificationPreferences, 'messagesEnabled' | 'reactionsEnabled'>) {
      const current = view().notificationPreferences
      if (current.messagesEnabled === preferences.messagesEnabled && current.reactionsEnabled === preferences.reactionsEnabled) {
        return Promise.resolve<SocialActionResult>({ ok: true })
      }
      const selected = { messagesEnabled: preferences.messagesEnabled, reactionsEnabled: preferences.reactionsEnabled }
      return run('notification-preferences', selected, { optimistic: { kind: 'notification-preferences', preferences: selected } })
    },
    toggleListeningWith(userId: string) {
      return run('listening', { targetUserId: userId })
    },
    createRoom(payload?: Record<string, unknown>) {
      return run('create-room', payload)
    },
  }

  return { actions, view, noteSnapshot, reset, pending: () => pending }
}

export type SocialAckActions = ReturnType<typeof createSocialAckActions>
