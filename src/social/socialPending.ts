import type {
  SocialMessageReaction,
  SocialNotificationPreferences,
  SocialPrivacy,
  SocialState,
} from './types'

// Optimistic changes shown on top of the gateway snapshot while an
// acknowledged action is on its way (src/social/socialAckActions.ts). The
// snapshot itself is never edited: a failed action only drops its entry, so
// whatever the gateway sent in the meantime shows through unchanged.
export type SocialPendingChange =
  | { kind: 'request-response'; userId: string }
  | { kind: 'message-reaction'; userId: string; messageId: string; reaction: SocialMessageReaction['reaction'] | '' }
  | { kind: 'notifications-read'; ids: string[] }
  | { kind: 'privacy'; privacy: SocialPrivacy }
  | { kind: 'notification-preferences'; preferences: Pick<SocialNotificationPreferences, 'messagesEnabled' | 'reactionsEnabled'> }

// `confirmed`: the gateway acknowledged it, so the next snapshot already
// carries the change and the entry can go.
export type SocialPendingEntry = SocialPendingChange & { token: string; confirmed: boolean }

// The gateway toggles: the same emoji again removes your reaction, another
// one replaces it (electron/social-hub.cjs social:message-reaction).
export function ownReactionAfterToggle(
  state: SocialState,
  userId: string,
  messageId: string,
  reaction: SocialMessageReaction['reaction'],
): SocialMessageReaction['reaction'] | '' {
  const message = (state.conversations[userId] || []).find((item) => item.id === messageId)
  const current = message?.reactions.find((item) => item.actorId === state.currentUser.id)?.reaction
  return current === reaction ? '' : reaction
}

export function applySocialPending(state: SocialState, pending: readonly SocialPendingEntry[]): SocialState {
  if (!pending.length) return state
  const respondedUserIds = new Set<string>()
  const readIds = new Set<string>()
  const reactions = new Map<string, Extract<SocialPendingChange, { kind: 'message-reaction' }>>()
  let privacy = state.privacy
  let notificationPreferences = state.notificationPreferences
  for (const entry of pending) {
    if (entry.kind === 'request-response') respondedUserIds.add(entry.userId)
    else if (entry.kind === 'notifications-read') for (const id of entry.ids) readIds.add(id)
    else if (entry.kind === 'message-reaction') reactions.set(`${entry.userId}\n${entry.messageId}`, entry)
    else if (entry.kind === 'privacy') privacy = entry.privacy
    else notificationPreferences = { ...notificationPreferences, ...entry.preferences }
  }

  let conversations = state.conversations
  if (reactions.size) {
    conversations = { ...state.conversations }
    const ownId = state.currentUser.id
    for (const { userId, messageId, reaction } of reactions.values()) {
      const messages = conversations[userId]
      if (!messages?.some((message) => message.id === messageId)) continue
      conversations[userId] = messages.map((message) => (message.id === messageId
        ? {
            ...message,
            reactions: [
              ...message.reactions.filter((item) => item.actorId !== ownId),
              ...(reaction ? [{ actorId: ownId, reaction }] : []),
            ],
          }
        : message))
    }
  }

  return {
    ...state,
    privacy,
    notificationPreferences,
    conversations,
    messageRequests: respondedUserIds.size
      ? state.messageRequests.filter((request) => !(request.direction === 'incoming' && respondedUserIds.has(request.userId)))
      : state.messageRequests,
    notifications: readIds.size
      ? state.notifications.map((notification) => (readIds.has(notification.id) && !notification.read
        ? { ...notification, read: true }
        : notification))
      : state.notifications,
  }
}
