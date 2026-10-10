// Windows notification text for a gateway notification. Same wording as the
// phone (src/social/socialModel.ts deviceNotificationContent). Unknown kinds
// return null and are never shown; reactions (to a message or to the profile)
// follow `reactionsEnabled`, messages and requests follow `messagesEnabled`.
const REACTION_KINDS = new Set(['reaction', 'profile_reaction'])
const KNOWN_KINDS = new Set(['message_request', 'message', 'reaction', 'profile_reaction'])

function desktopSocialNotificationContent(notification, actorName, preferences = {}) {
  const kind = notification?.kind
  if (!KNOWN_KINDS.has(kind)) return null
  if (REACTION_KINDS.has(kind) && preferences.reactionsEnabled === false) return null
  if (!REACTION_KINDS.has(kind) && preferences.messagesEnabled === false) return null
  const body = typeof notification.body === 'string' ? notification.body : ''
  if (kind === 'message_request') return { title: `${actorName} mesaj isteği gönderdi`, body }
  if (kind === 'message') return { title: `${actorName} sana yazdı`, body }
  if (kind === 'reaction') return { title: `${actorName} mesajına tepki verdi`, body: `${body} tepkisi` }
  return { title: `${actorName} profiline ${body} bıraktı`, body: '' }
}

module.exports = { desktopSocialNotificationContent }
