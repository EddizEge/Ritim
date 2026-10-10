import { useEffect, useRef, useState } from 'react'
import { Headphones, LogIn, MessageCircle, Radio, RefreshCw, WifiOff } from 'lucide-react'
import { clockLabel, connectionTone } from '../../social/socialModel'
import type { SocialState } from '../../social/types'

// Shown while Ritim Social cannot be reached (and while reconnecting after
// that). Music and the phone remote keep working; the band says so.
export function useOfflineBand(state: Pick<SocialState, 'connectionStatus'>) {
  const tone = connectionTone(state.connectionStatus)
  const [shown, setShown] = useState(tone === 'offline')
  useEffect(() => {
    if (tone === 'offline') setShown(true)
    if (tone === 'online') setShown(false)
  }, [tone])
  return shown && tone !== 'online'
}

export function OfflineBand({ state, onReconnect, compact = false }: { state: SocialState; onReconnect: () => void; compact?: boolean }) {
  const connecting = connectionTone(state.connectionStatus) === 'connecting'
  return (
    <section className={`rs-offline ${compact ? 'is-compact' : ''}`} role="status">
      <div className="rs-offline-copy">
        <span className="rs-offline-icon"><WifiOff aria-hidden="true" /></span>
        <div>
          <b>Ritim Sosyal’e ulaşılamıyor</b>
          <p>Müzik ve telefon kumandası çalışmaya devam ediyor.{compact ? '' : ' Aşağıda son bilinen durum var; bağlantı gelince kendiliğinden yenilenir.'}</p>
        </div>
      </div>
      <button type="button" className={`rs-button is-wide ${connecting ? 'is-busy' : 'is-primary'}`} disabled={connecting} onClick={onReconnect}>
        <RefreshCw aria-hidden="true" className={connecting ? 'rs-spin' : ''} />{connecting ? 'Bağlanıyor…' : 'Yeniden bağlan'}
      </button>
      {state.lastOnlineAt ? <p className="rs-offline-last">Son başarılı bağlantı {clockLabel(state.lastOnlineAt)}</p> : null}
    </section>
  )
}

function Hero() {
  return (
    <div className="rs-hero" aria-hidden="true">
      <span className="rs-hero-cover cover cover-1 is-left" />
      <span className="rs-hero-cover cover cover-4 is-right" />
      <span className="rs-hero-cover cover cover-0 is-center" />
    </div>
  )
}

function Features() {
  return (
    <ul className="rs-features">
      <li><span><Headphones aria-hidden="true" /></span>Kimin ne dinlediğini gör</li>
      <li><span><MessageCircle aria-hidden="true" /></span>Mesajlaş, tepki gönder</li>
      <li><span><Radio aria-hidden="true" /></span>Dinleme odalarına katıl</li>
    </ul>
  )
}

// Phone without a Ritim Social session: the phone joins through the PC's
// account, so the steps point there.
export function PhoneSignedOut({ onRetry }: { onRetry: () => Promise<unknown> | void }) {
  const [checking, setChecking] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const retry = async () => {
    setChecking(true)
    try { await onRetry() } finally { if (mounted.current) setChecking(false) }
  }
  return (
    <div className="rs-signed-out">
      <header className="rs-hub-header"><h1>Sosyal</h1></header>
      <Hero />
      <h2>Arkadaşlarınla birlikte dinle</h2>
      <Features />
      <section className="rs-steps" aria-label="Nasıl bağlanır">
        <b>Telefon, bilgisayarındaki hesapla bağlanır</b>
        <ol>
          <li><span>1</span>Bilgisayarda Ritim › Sosyal’i aç</li>
          <li><span>2</span>Google ile giriş yap</li>
          <li><span>3</span>Bu telefon kendiliğinden eklenir</li>
        </ol>
      </section>
      <button type="button" className={`rs-button is-wide is-large ${checking ? 'is-busy' : 'is-primary'}`} disabled={checking} onClick={() => void retry()}>
        <RefreshCw aria-hidden="true" className={checking ? 'rs-spin' : ''} />{checking ? 'Hesap kontrol ediliyor…' : 'Yeniden dene'}
      </button>
      <p className="rs-signed-out-note">Sosyal isteğe bağlı. Müzik ve telefon kumandası hesapsız da çalışır.</p>
    </div>
  )
}

// PC without a session: the existing main-process Google sign-in flow.
export function DesktopSignedOut({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <div className="rs-signed-out is-desktop">
      <Hero />
      <h2>Arkadaşlarınla birlikte dinle</h2>
      <Features />
      {onSignIn ? (
        <button type="button" className="rs-button is-primary is-large" onClick={onSignIn}><LogIn aria-hidden="true" />Google ile giriş yap</button>
      ) : null}
      <p className="rs-signed-out-note">Giriş tarayıcında açılır. Telefonun bu hesaba kendiliğinden eklenir. Sosyal isteğe bağlı; müzik ve telefon kumandası hesapsız da çalışır.</p>
    </div>
  )
}
