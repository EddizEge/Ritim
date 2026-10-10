import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { SOCIAL_REPORT_DETAIL_MAX_LENGTH } from '../../social/socialShared'
import { REPORT_REASONS, accusative } from '../../social/socialModel'
import type { SocialActionResult } from '../../social/types'
import { usePresence } from './usePresence'

const SHEET_EXIT_MS = 240

function useEscape(active: boolean, onEscape: () => void) {
  const callback = useRef(onEscape)
  callback.current = onEscape
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') callback.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

// Phone: a bottom sheet that slides up on the drawer curve. PC: a centred
// dialog that scales from .95. Tapping the dimmed backdrop closes either.
export function Sheet({ open, onClose, label, desktop, children }: {
  open: boolean
  onClose: () => void
  label: string
  desktop: boolean
  children: ReactNode
}) {
  const { mounted, closing } = usePresence(open, SHEET_EXIT_MS)
  const panelRef = useRef<HTMLElement | null>(null)
  useEscape(open, onClose)
  useEffect(() => {
    if (!open) return
    const first = panelRef.current?.querySelector<HTMLElement>('button, textarea, input')
    first?.focus({ preventScroll: true })
  }, [open])
  if (!mounted) return null
  return (
    <div className={`rs-sheet-layer ${desktop ? 'is-dialog' : 'is-sheet'} ${closing ? 'is-closing' : ''}`}>
      <button type="button" className="rs-sheet-backdrop" aria-label="Kapat" tabIndex={-1} onClick={onClose} />
      <section ref={panelRef} className="rs-sheet" role="dialog" aria-modal="true" aria-label={label}>
        {!desktop ? <div className="rs-sheet-handle" aria-hidden="true" /> : null}
        {children}
      </section>
    </div>
  )
}

export function ReportSheet({ open, name, desktop, onClose, onSubmit }: {
  open: boolean
  name: string
  desktop: boolean
  onClose: () => void
  onSubmit: (reason: string, detail: string) => Promise<SocialActionResult>
}) {
  const [reason, setReason] = useState<string>(REPORT_REASONS[0])
  const [detail, setDetail] = useState('')
  const [saved, setSaved] = useState(false)
  const [sending, setSending] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!open) return
    setReason(REPORT_REASONS[0])
    setDetail('')
    setSaved(false)
    setSending(false)
  }, [open])
  return (
    <Sheet open={open} onClose={onClose} label={`${name} için şikâyet`} desktop={desktop}>
      {saved ? (
        <div className="rs-sheet-done">
          <Check aria-hidden="true" />
          <b>Şikâyetin kaydedildi</b>
          <p>Durumunu Ayarlar › Güvenlik › Şikâyet geçmişi’nde görebilirsin.</p>
          <button type="button" className="rs-button is-secondary is-wide" onClick={onClose}>Kapat</button>
        </div>
      ) : (
        <form onSubmit={(event) => {
          event.preventDefault()
          if (sending) return
          // "Kaydedildi" only after the gateway confirmed it; on a failure the
          // form stays filled in and the store shows why.
          setSending(true)
          void onSubmit(reason, detail).then((result) => {
            if (!openRef.current) return
            setSending(false)
            if (result.ok) setSaved(true)
          })
        }}>
          <h2>{accusative(name)} şikâyet et</h2>
          <p className="rs-sheet-copy">Son mesajı şikâyete eklenir. {name} bundan haberdar edilmez.</p>
          <div className="rs-radio-list" role="radiogroup" aria-label="Şikâyet nedeni">
            {REPORT_REASONS.map((item) => (
              <button key={item} type="button" role="radio" aria-checked={reason === item} className={reason === item ? 'is-selected' : ''} onClick={() => setReason(item)}>
                <span className="rs-radio" aria-hidden="true"><i /></span>{item}
              </button>
            ))}
          </div>
          <label className="rs-textarea">
            <span>Açıklama <small>(isteğe bağlı)</small></span>
            <textarea value={detail} maxLength={SOCIAL_REPORT_DETAIL_MAX_LENGTH} rows={3} onChange={(event) => setDetail(event.target.value)} placeholder="Ne olduğunu kısaca anlat" />
          </label>
          <div className="rs-sheet-actions">
            <button type="button" className="rs-button is-secondary" onClick={onClose}>Vazgeç</button>
            <button type="submit" className="rs-button is-primary" disabled={sending}>{sending ? 'Gönderiliyor…' : 'Şikâyeti gönder'}</button>
          </div>
        </form>
      )}
    </Sheet>
  )
}

export function ConfirmSheet({ open, title, children, confirmLabel, desktop, onClose, onConfirm }: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  desktop: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} label={title} desktop={desktop}>
      <h2>{title}</h2>
      <p className="rs-sheet-copy">{children}</p>
      <div className="rs-sheet-actions">
        <button type="button" className="rs-button is-secondary" onClick={onClose}>Vazgeç</button>
        <button type="button" className="rs-button is-primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Sheet>
  )
}

export function BlockSheet({ open, name, desktop, onClose, onConfirm }: {
  open: boolean
  name: string
  desktop: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmSheet open={open} title={`${name} engellensin mi?`} confirmLabel="Engelle" desktop={desktop} onClose={onClose} onConfirm={onConfirm}>
      Engellediğin kişi sana yazamaz ve birbirinizi listelerde görmezsiniz. Engeli sonra Ayarlar › Güvenlik’ten kaldırabilirsin.
    </ConfirmSheet>
  )
}

// Menus grow out of their trigger (.95 → 1, 150 ms) and close on an outside
// click or Escape.
export function Popover({ open, onClose, className = '', label, children }: {
  open: boolean
  onClose: () => void
  className?: string
  label: string
  children: ReactNode
}) {
  const { mounted, closing } = usePresence(open, 120)
  useEscape(open, onClose)
  if (!mounted) return null
  return (
    <>
      <button type="button" className="rs-popover-catcher" aria-label="Menüyü kapat" tabIndex={-1} onClick={onClose} />
      <div className={`rs-popover ${className} ${closing ? 'is-closing' : ''}`} role="menu" aria-label={label}>
        {children}
      </div>
    </>
  )
}
