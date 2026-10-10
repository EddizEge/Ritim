const crypto = require('node:crypto')

// Renderer requests reach the social gateway only through this table. The
// token-bearing socket stays in the main process; the renderer names an action
// and the bridge validates its payload before emitting the mapped event.
// `ack: true` marks events whose gateway handler answers the acknowledgement
// callback (electron/social-hub.cjs) with `{ ok: true }` or `{ ok: false, code }`.
// Every remote action is acknowledged; `emit` keeps a fire-and-forget path for
// an entry that is not.
const SOCIAL_ACTIONS = Object.freeze({
  message: { event: 'social:message', ack: true },
  'room-message': { event: 'social:room-message', ack: true },
  'room-reaction': { event: 'social:room-reaction', ack: true },
  'room-membership': { event: 'social:room-membership', ack: true },
  reaction: { event: 'social:reaction', ack: true },
  'message-reaction': { event: 'social:message-reaction', ack: true },
  'request-response': { event: 'social:request-response', ack: true },
  read: { event: 'social:read', ack: true },
  'notifications-read': { event: 'social:notifications-read', ack: true },
  privacy: { event: 'social:privacy', ack: true },
  'notification-preferences': { event: 'social:notification-preferences', ack: true },
  mute: { event: 'social:mute', ack: true },
  report: { event: 'social:report', ack: true },
  block: { event: 'social:block', ack: true },
  listening: { event: 'social:listening', ack: true },
  'create-room': { event: 'social:create-room', ack: true },
})

// Handled by the main process itself (OAuth, reconnect, device preferences,
// opening the Settings window on a social section).
const LOCAL_SOCIAL_ACTIONS = Object.freeze(['reconnect', 'sign-in', 'sign-out', 'device-notifications', 'open-settings'])
const SETTINGS_SECTIONS = new Set(['social', 'notifications'])

const DEFAULT_ACK_TIMEOUT_MS = 5_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VISIBILITIES = new Set(['everyone', 'contacts', 'hidden'])
const MESSAGE_REACTIONS = new Set(['♥', '🔥', '😂', '👍'])
const ROOM_REACTIONS = new Set(['♥', '🔥', '👏', '🎵'])
const ACK_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

// Limits mirror the gateway (electron/social-hub.cjs cleanText calls).
const LIMITS = Object.freeze({
  id: 80,
  message: 500,
  roomMessage: 280,
  reaction: 8,
  reportReason: 120,
  reportDetail: 2_000,
})

class SocialPayloadError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredId(value) {
  if (typeof value !== 'string') throw new SocialPayloadError('invalid_payload')
  const clean = value.trim()
  if (!clean || clean.length > LIMITS.id) throw new SocialPayloadError('invalid_payload')
  return clean
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return ''
  return requiredId(value)
}

function boundedText(value, maxLength, tooLongCode, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new SocialPayloadError('invalid_payload')
    return ''
  }
  if (typeof value !== 'string') throw new SocialPayloadError('invalid_payload')
  const clean = value.trim()
  if (required && !clean) throw new SocialPayloadError('invalid_payload')
  if (clean.length > maxLength) throw new SocialPayloadError(tooLongCode)
  return clean
}

function clientMessageId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : crypto.randomUUID()
}

function oneOf(value, allowed) {
  if (!allowed.has(value)) throw new SocialPayloadError('invalid_payload')
  return value
}

const PAYLOAD_NORMALIZERS = {
  message: (payload) => ({
    targetUserId: requiredId(payload.targetUserId),
    text: boundedText(payload.text, LIMITS.message, 'message_too_long'),
    clientMessageId: clientMessageId(payload.clientMessageId),
  }),
  'room-message': (payload) => ({
    roomId: requiredId(payload.roomId),
    text: boundedText(payload.text, LIMITS.roomMessage, 'room_message_too_long'),
    clientMessageId: clientMessageId(payload.clientMessageId),
  }),
  'room-reaction': (payload) => ({
    roomId: requiredId(payload.roomId),
    reaction: oneOf(payload.reaction, ROOM_REACTIONS),
  }),
  'room-membership': (payload) => ({ roomId: requiredId(payload.roomId) }),
  reaction: (payload) => ({
    targetUserId: requiredId(payload.targetUserId),
    reaction: boundedText(payload.reaction, LIMITS.reaction, 'invalid_payload', { required: false }) || '♥',
  }),
  'message-reaction': (payload) => ({
    targetUserId: requiredId(payload.targetUserId),
    messageId: requiredId(payload.messageId),
    reaction: oneOf(payload.reaction, MESSAGE_REACTIONS),
  }),
  'request-response': (payload) => ({
    requesterUserId: requiredId(payload.requesterUserId),
    action: oneOf(payload.action, new Set(['accept', 'reject'])),
  }),
  read: (payload) => ({ targetUserId: requiredId(payload.targetUserId) }),
  'notifications-read': () => ({}),
  privacy: (payload) => ({
    profileVisibility: oneOf(payload.profileVisibility, VISIBILITIES),
    listeningVisibility: oneOf(payload.listeningVisibility, VISIBILITIES),
  }),
  'notification-preferences': (payload) => {
    if (typeof payload.messagesEnabled !== 'boolean' || typeof payload.reactionsEnabled !== 'boolean') {
      throw new SocialPayloadError('invalid_payload')
    }
    return { messagesEnabled: payload.messagesEnabled, reactionsEnabled: payload.reactionsEnabled }
  },
  mute: (payload) => ({ targetUserId: requiredId(payload.targetUserId) }),
  block: (payload) => ({ targetUserId: requiredId(payload.targetUserId) }),
  report: (payload) => {
    const reason = boundedText(payload.reason, LIMITS.reportReason, 'invalid_payload')
    if (reason.length < 3) throw new SocialPayloadError('invalid_payload')
    return {
      targetUserId: requiredId(payload.targetUserId),
      reason,
      detail: boundedText(payload.detail, LIMITS.reportDetail, 'invalid_payload', { required: false }),
      messageId: optionalId(payload.messageId),
    }
  },
  // An empty target leaves the current listening room (gateway clearListening).
  listening: (payload) => ({ targetUserId: optionalId(payload.targetUserId) }),
  // Title and cover come from the PC's own player state in main.cjs.
  'create-room': () => ({}),
  reconnect: () => ({}),
  'sign-in': () => ({}),
  'sign-out': () => ({}),
  'device-notifications': (payload) => {
    if (typeof payload.enabled !== 'boolean') throw new SocialPayloadError('invalid_payload')
    return { enabled: payload.enabled }
  },
  'open-settings': (payload) => ({ section: oneOf(payload.section, SETTINGS_SECTIONS) }),
}

function normalizeSocialAction(type, payload) {
  if (typeof type !== 'string' || !Object.hasOwn(PAYLOAD_NORMALIZERS, type)) {
    return { ok: false, code: 'unknown_action' }
  }
  if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
    return { ok: false, code: 'invalid_payload' }
  }
  try {
    const normalized = PAYLOAD_NORMALIZERS[type](payload || {})
    const remote = SOCIAL_ACTIONS[type]
    return {
      ok: true,
      type,
      local: !remote,
      event: remote?.event,
      ack: Boolean(remote?.ack),
      payload: normalized,
    }
  } catch (error) {
    if (error instanceof SocialPayloadError) return { ok: false, code: error.code }
    throw error
  }
}

// Only these acknowledgement fields cross back into the renderer.
function sanitizeAckResult(value) {
  const result = isPlainObject(value) ? value : {}
  const sanitized = { ok: result.ok === true }
  if (typeof result.code === 'string' && ACK_CODE_PATTERN.test(result.code)) sanitized.code = result.code
  if (typeof result.duplicate === 'boolean') sanitized.duplicate = result.duplicate
  if (result.status === 'joined' || result.status === 'left') sanitized.status = result.status
  if (!sanitized.ok && !sanitized.code) sanitized.code = 'rejected'
  return sanitized
}

function emitWithAck(socket, event, payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, code: 'timeout' })
    }, timeoutMs)
    timeout.unref?.()
    try {
      socket.emit(event, payload, (result) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(sanitizeAckResult(result))
      })
    } catch {
      settled = true
      clearTimeout(timeout)
      resolve({ ok: false, code: 'offline' })
    }
  })
}

function createSocialActionBridge({ getSocket, timeoutMs = DEFAULT_ACK_TIMEOUT_MS } = {}) {
  if (typeof getSocket !== 'function') throw new TypeError('getSocket is required')

  // `action` must come from normalizeSocialAction and be a remote action.
  async function emit(action) {
    if (!action?.ok || action.local || !action.event) return { ok: false, code: 'unknown_action' }
    const socket = getSocket()
    if (!socket?.connected) return { ok: false, code: 'offline' }
    if (action.ack) return emitWithAck(socket, action.event, action.payload, timeoutMs)
    try {
      socket.emit(action.event, action.payload)
    } catch {
      return { ok: false, code: 'offline' }
    }
    return { ok: true, acknowledged: false }
  }

  async function dispatch(type, payload) {
    const action = normalizeSocialAction(type, payload)
    if (!action.ok) return action
    if (action.local) return { ok: false, code: 'unknown_action' }
    return emit(action)
  }

  return { emit, dispatch }
}

// Phone and PC show the same Social tab badge: unread conversations plus
// incoming message requests (src/components/MobileApp.tsx).
function socialBadgeCount(state) {
  const unread = Object.values(state?.unreadCounts || {})
    .reduce((total, count) => total + (Number.isFinite(count) && count > 0 ? count : 0), 0)
  const incoming = (state?.messageRequests || []).filter((request) => request?.direction === 'incoming').length
  return unread + incoming
}

// The renderer only needs to know whether and as whom it is signed in; device
// records and anything token-related stay in the main process.
function publicSocialAuthentication(status) {
  const user = status?.user
  return {
    configured: Boolean(status?.configured),
    required: Boolean(status?.required),
    authenticated: Boolean(status?.authenticated),
    user: user && typeof user === 'object' ? {
      id: typeof user.id === 'string' ? user.id : '',
      displayName: typeof user.displayName === 'string' ? user.displayName : '',
      handle: typeof user.handle === 'string' ? user.handle : '',
      initials: typeof user.initials === 'string' ? user.initials : '',
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : undefined,
      avatarTone: Number(user.avatarTone) || 0,
    } : undefined,
  }
}

// Gateway `social:error` events forwarded to the Social view; only the code
// and the originating event name are passed on.
function sanitizeSocialErrorEvent(value) {
  const error = isPlainObject(value) ? value : {}
  return {
    kind: 'error',
    code: typeof error.code === 'string' && ACK_CODE_PATTERN.test(error.code) ? error.code : 'unknown',
    event: typeof error.event === 'string' && /^[a-z][a-z:-]{0,39}$/.test(error.event) ? error.event : '',
  }
}

module.exports = {
  DEFAULT_ACK_TIMEOUT_MS,
  LIMITS,
  LOCAL_SOCIAL_ACTIONS,
  SETTINGS_SECTIONS,
  SOCIAL_ACTIONS,
  createSocialActionBridge,
  normalizeSocialAction,
  publicSocialAuthentication,
  sanitizeAckResult,
  sanitizeSocialErrorEvent,
  socialBadgeCount,
}
