import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Info } from 'lucide-react'
import { createToastTimer } from '../../social/toastTimer'
import { usePresence } from './usePresence'
import type { ToastItem } from './useSocialHub'

// Feedback appears as a toast, never as a band pushed into the layout: above
// the mini player on the phone, bottom-right on the PC. It enters in 200 ms,
// leaves after about 4 s and its timer stops while the page is hidden or the
// pointer rests on it.
export function Toaster({ toast, onDone, placement }: {
  toast: ToastItem | null
  onDone: () => void
  placement: 'above-mini' | 'above-nav' | 'screen' | 'desktop'
}) {
  const [shown, setShown] = useState<ToastItem | null>(toast)
  const { mounted, closing } = usePresence(Boolean(toast), 150)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const timerRef = useRef<ReturnType<typeof createToastTimer> | null>(null)

  useEffect(() => {
    if (toast) setShown(toast)
  }, [toast])

  useEffect(() => {
    if (!toast) return
    const timer = createToastTimer(() => doneRef.current())
    timerRef.current = timer
    if (!document.hidden) timer.start()
    const onVisibility = () => (document.hidden ? timer.pause() : timer.resume())
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      timer.cancel()
      timerRef.current = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [toast])

  if (!mounted || !shown) return null
  const Icon = shown.tone === 'success' ? Check : shown.tone === 'error' ? AlertCircle : Info
  return (
    <div
      key={shown.id}
      className={`rs-toast is-${shown.tone} is-${placement} ${closing ? 'is-closing' : ''}`}
      role={shown.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => timerRef.current?.pause()}
      onPointerLeave={() => { if (!document.hidden) timerRef.current?.resume() }}
    >
      <Icon aria-hidden="true" />
      <span>{shown.text}</span>
    </div>
  )
}
