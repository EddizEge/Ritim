import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SOCIAL_TEXT } from '../../social/socialShared'
import { createSocialOutbox, type SocialOutbox } from '../../social/socialOutbox'
import type { SocialActions, SocialFeedback, SocialState } from '../../social/types'

export type ToastItem = { id: string; tone: SocialFeedback['tone']; text: string }

// One outbox per page: the phone's Social tab unmounts when you switch tabs
// and a failed message must still be there (with its clientMessageId) when you
// come back.
let sharedOutbox: SocialOutbox | null = null
let outboxSend: SocialActions['sendMessage'] | null = null

function outboxFor(actions: SocialActions) {
  outboxSend = actions.sendMessage
  if (!sharedOutbox) {
    sharedOutbox = createSocialOutbox({
      send: (userId, text, clientMessageId) => outboxSend
        ? outboxSend(userId, text, clientMessageId)
        : Promise.resolve({ ok: false, code: 'offline' }),
    })
  }
  return sharedOutbox
}

export function useSocialOutbox(state: SocialState, actions: SocialActions) {
  const outbox = outboxFor(actions)
  const entries = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot)
  useEffect(() => {
    outbox.reconcile(state.conversations)
  }, [outbox, state.conversations])
  // Another account signed in on this device: its chats must not show the
  // previous account's unsent messages.
  const accountRef = useRef(state.currentUser.id)
  useEffect(() => {
    if (accountRef.current && state.currentUser.id && accountRef.current !== state.currentUser.id) outbox.clear()
    if (state.currentUser.id) accountRef.current = state.currentUser.id
  }, [outbox, state.currentUser.id])
  return { entries, send: outbox.send, retry: outbox.retry }
}

const LEAVE_MS = 160
const RESTORE_MS = 8_000

// Shared state of a social hub (phone or PC): toasts, drafts, sent hearts,
// rows on their way out, and the gateway feedback turned into toasts.
export function useSocialHub(state: SocialState, actions: SocialActions) {
  const outbox = useSocialOutbox(state, actions)
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [hearted, setHearted] = useState<ReadonlySet<string>>(() => new Set())
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set())
  const suppressedRef = useRef<{ text: string; until: number }>({ text: '', until: 0 })
  const timersRef = useRef<number[]>([])

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
  }, [])

  const showToast = useCallback((tone: ToastItem['tone'], text: string) => {
    setToast({ id: crypto.randomUUID(), tone, text })
  }, [])

  // A screen that already confirmed something in place (e.g. the report
  // sheet) can hide the matching gateway notice for a short while.
  const suppressFeedback = useCallback((text: string, ms = 8_000) => {
    suppressedRef.current = { text, until: Date.now() + ms }
  }, [])

  const feedbackId = state.feedback?.id
  useEffect(() => {
    const feedback = state.feedback
    if (!feedback) return
    const suppressed = suppressedRef.current
    if (!(suppressed.text === feedback.text && suppressed.until > Date.now())) {
      setToast({ id: feedback.id, tone: feedback.tone, text: feedback.text })
    }
    actions.clearFeedback()
    // Runs once per feedback id.
  }, [feedbackId])

  const setDraft = useCallback((userId: string, value: string) => {
    setDrafts((current) => (current[userId] === value ? current : { ...current, [userId]: value }))
  }, [])

  const sendHeart = useCallback((userId: string) => {
    actions.reactToUser(userId, '♥')
    setHearted((current) => (current.has(userId) ? current : new Set([...current, userId])))
  }, [actions])

  // The row fades and shrinks for 160 ms, then disappears and the action
  // runs. If the gateway never removes it, it comes back after a while.
  const leaveThen = useCallback((id: string, action: () => void) => {
    setLeaving((current) => new Set([...current, id]))
    timersRef.current.push(window.setTimeout(() => {
      setLeaving((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setGone((current) => new Set([...current, id]))
      action()
      timersRef.current.push(window.setTimeout(() => {
        setGone((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, RESTORE_MS))
    }, LEAVE_MS))
  }, [])

  const respondToRequest = useCallback((userId: string, name: string, action: 'accept' | 'reject') => {
    leaveThen(`request:${userId}`, () => {
      actions.respondToMessageRequest(userId, action)
      showToast('success', action === 'accept'
        ? `${name} isteğini kabul ettin. Artık yazışabilirsiniz.`
        : `${name} isteği reddedildi; mesajları silindi.`)
    })
  }, [actions, leaveThen, showToast])

  const reportUser = useCallback((userId: string, reason: string, detail: string, messageId?: string) => {
    suppressFeedback(SOCIAL_TEXT.reportSaved)
    actions.reportUser(userId, reason, detail, messageId)
  }, [actions, suppressFeedback])

  return useMemo(() => ({
    outbox,
    toast,
    showToast,
    dismissToast: () => setToast(null),
    drafts,
    setDraft,
    hearted,
    sendHeart,
    leaving,
    gone,
    respondToRequest,
    reportUser,
  }), [drafts, gone, hearted, leaving, outbox, reportUser, respondToRequest, sendHeart, setDraft, showToast, toast])
}

export type SocialHubModel = ReturnType<typeof useSocialHub>
