// Auto-dismiss timer for social toasts. It pauses while the document is hidden
// (and while the pointer rests on the toast) and resumes with the time that
// was left, so a toast is never missed because the window was in the
// background.

export const TOAST_DURATION_MS = 4_000

type TimerApi = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export function createToastTimer(onExpire: () => void, { duration = TOAST_DURATION_MS, timers = defaultTimers } = {}) {
  let remaining = duration
  let startedAt = 0
  let handle: unknown
  let running = false
  let finished = false

  function fire() {
    running = false
    finished = true
    remaining = 0
    onExpire()
  }

  function start() {
    if (running || finished) return
    running = true
    startedAt = timers.now()
    handle = timers.setTimeout(fire, Math.max(0, remaining))
  }

  function pause() {
    if (!running) return
    timers.clearTimeout(handle)
    remaining = Math.max(0, remaining - (timers.now() - startedAt))
    running = false
  }

  return {
    start,
    pause,
    resume: start,
    cancel() {
      if (running) timers.clearTimeout(handle)
      running = false
      finished = true
    },
    get remaining() {
      return running ? Math.max(0, remaining - (timers.now() - startedAt)) : remaining
    },
    get running() {
      return running
    },
  }
}
