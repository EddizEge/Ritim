import { useEffect, useState } from 'react'

// Keeps a closing element mounted for its exit transition. Entering uses CSS
// `@starting-style`; leaving sets `closing` so the element can fade/slide out
// before it is removed.
export function usePresence(open: boolean, exitMs: number) {
  const [rendered, setRendered] = useState(open)
  useEffect(() => {
    if (open) {
      setRendered(true)
      return
    }
    const timer = window.setTimeout(() => setRendered(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [exitMs, open])
  return { mounted: open || rendered, closing: !open && rendered }
}
