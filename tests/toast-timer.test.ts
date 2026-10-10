import assert from 'node:assert/strict'
import test from 'node:test'
import { TOAST_DURATION_MS, createToastTimer } from '../src/social/toastTimer'

function fakeTimers() {
  let now = 0
  let nextId = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        nextId += 1
        pending.set(nextId, { at: now + ms, callback })
        return nextId
      },
      clearTimeout: (handle: unknown) => { pending.delete(handle as number) },
      now: () => now,
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...pending.entries()]) {
        if (timer.at <= now) {
          pending.delete(id)
          timer.callback()
        }
      }
    },
    pendingCount: () => pending.size,
  }
}

test('tost yaklaşık 4 sn sonra bir kez kapanır', () => {
  const clock = fakeTimers()
  let closed = 0
  const timer = createToastTimer(() => { closed += 1 }, { timers: clock.timers })
  assert.equal(TOAST_DURATION_MS, 4_000)
  timer.start()
  timer.start()
  assert.equal(clock.pendingCount(), 1)
  clock.advance(3_999)
  assert.equal(closed, 0)
  clock.advance(1)
  assert.equal(closed, 1)
  timer.resume()
  clock.advance(10_000)
  assert.equal(closed, 1)
})

test('belge gizliyken zamanlayıcı durur, kalan süreyle devam eder', () => {
  const clock = fakeTimers()
  let closed = 0
  const timer = createToastTimer(() => { closed += 1 }, { timers: clock.timers })
  timer.start()
  clock.advance(1_500)
  timer.pause()
  assert.equal(timer.remaining, 2_500)
  assert.equal(timer.running, false)
  clock.advance(60_000)
  assert.equal(closed, 0)
  timer.resume()
  clock.advance(2_499)
  assert.equal(closed, 0)
  clock.advance(1)
  assert.equal(closed, 1)
})

test('iptal edilen tost kapanma çağrısı yapmaz; gizli açılan tost görünür olunca sayar', () => {
  const clock = fakeTimers()
  let closed = 0
  const cancelled = createToastTimer(() => { closed += 1 }, { timers: clock.timers })
  cancelled.start()
  cancelled.cancel()
  clock.advance(5_000)
  assert.equal(closed, 0)
  cancelled.resume()
  assert.equal(clock.pendingCount(), 0)

  const hidden = createToastTimer(() => { closed += 1 }, { timers: clock.timers, duration: 1_000 })
  clock.advance(9_000)
  assert.equal(closed, 0)
  hidden.resume()
  clock.advance(1_000)
  assert.equal(closed, 1)
})
