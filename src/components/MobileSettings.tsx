import { useState } from 'react'
import { AlertCircle, Laptop, LogOut, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import type { SocialAccountState } from '../hooks/useSocialAccount'

type Props = {
  account: SocialAccountState
  onRefresh: () => Promise<unknown>
  onReconnect: () => Promise<unknown>
  onRevokeDevice: (deviceId: string) => Promise<void>
  onSignOut: () => Promise<void>
}

function lastSeenLabel(value?: string) {
  if (!value) return 'Henüz çevrimiçi görülmedi'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'Son görülme bilinmiyor'
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (elapsedMinutes < 2) return 'Şimdi çevrimiçi'
  if (elapsedMinutes < 60) return `${elapsedMinutes} dk önce görüldü`
  if (elapsedMinutes < 1_440) return `${Math.round(elapsedMinutes / 60)} sa önce görüldü`
  return new Date(timestamp).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })
}

export function MobileSettings({ account, onRefresh, onReconnect, onRevokeDevice, onSignOut }: Props) {
  const [busyDeviceId, setBusyDeviceId] = useState('')
  const [actionError, setActionError] = useState('')

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusyDeviceId(key)
    setActionError('')
    try { await action() } catch (error) {
      setActionError(error instanceof Error ? error.message : 'İşlem tamamlanamadı.')
    } finally { setBusyDeviceId('') }
  }

  if (account.status === 'loading' && !account.user) {
    return <div className="mobile-settings-state"><i /><i /><i /><b>Hesabın hazırlanıyor</b><p>Ritim kimliğin ve bağlı cihazların güvenli biçimde alınıyor.</p></div>
  }

  if (account.status === 'offline' || account.status === 'error') {
    return (
      <div className="mobile-settings-state is-error">
        <AlertCircle />
        <b>{account.status === 'offline' ? 'Şu anda çevrimdışısın' : 'Hesap bilgileri alınamadı'}</b>
        <p>{account.error || 'Müzik kumandası çalışmaya devam eder. Bağlantı gelince yeniden deneyebilirsin.'}</p>
        <button onClick={() => void onRefresh()}><RefreshCw />Tekrar dene</button>
      </div>
    )
  }

  if (!account.authenticated || !account.user) {
    return (
      <div className="mobile-settings-state">
        <ShieldCheck />
        <b>Ritim Sosyal’e bağlı değilsin</b>
        <p>Bu telefon eşlenmiş PC üzerinden aynı sosyal hesaba güvenli biçimde eklenir.</p>
        <button onClick={() => void run('reconnect', onReconnect)} disabled={busyDeviceId === 'reconnect'}>
          <RefreshCw />{busyDeviceId === 'reconnect' ? 'Bağlanıyor…' : 'Hesabı yeniden bağla'}
        </button>
      </div>
    )
  }

  return (
    <div className="mobile-settings-page">
      <section className="mobile-account-card">
        <span className="mobile-account-avatar" style={account.user.avatarUrl ? { backgroundImage: `url(${account.user.avatarUrl})` } : undefined}>
          {!account.user.avatarUrl ? account.user.initials : null}
        </span>
        <div><h2>{account.user.displayName}</h2><p>{account.user.handle}</p></div>
        <span className="mobile-account-live"><i />Bağlı</span>
        <dl>
          <div><dt>Ritim kimliği</dt><dd>{account.user.id}</dd></div>
          <div><dt>Oturum</dt><dd>Google ile doğrulandı</dd></div>
        </dl>
      </section>

      <section className="mobile-device-section">
        <header><div><h2>Cihazların</h2><p>Aynı Ritim hesabına bağlı PC ve telefonlar.</p></div><button onClick={() => void onRefresh()} aria-label="Cihazları yenile"><RefreshCw /></button></header>
        {account.devices.length ? <div className="mobile-device-list">{account.devices.map((device) => {
          const current = device.id === account.currentDeviceId
          return (
            <article key={device.id}>
              <span className="mobile-device-icon">{device.role === 'desktop' ? <Laptop /> : <Smartphone />}</span>
              <div><b>{device.name}</b><small>{device.role === 'desktop' ? 'Bilgisayar' : 'Telefon'} · {lastSeenLabel(device.lastSeenAt)}</small></div>
              {current ? <em>Bu cihaz</em> : <button disabled={busyDeviceId === device.id} onClick={() => {
                if (window.confirm(`${device.name} cihazının Ritim Sosyal erişimi kaldırılsın mı?`)) {
                  void run(device.id, () => onRevokeDevice(device.id))
                }
              }}>{busyDeviceId === device.id ? 'Kaldırılıyor…' : 'Kaldır'}</button>}
            </article>
          )
        })}</div> : <div className="mobile-device-empty">Bu hesaba bağlı etkin cihaz bulunamadı.</div>}
      </section>

      {account.warning ? <p className="mobile-settings-warning">{account.warning}</p> : null}

      {actionError ? <p className="mobile-settings-error" role="alert">{actionError}</p> : null}
      <button className="mobile-signout-button" disabled={busyDeviceId === 'signout'} onClick={() => {
        if (window.confirm('Bu telefondaki Ritim Sosyal oturumu kapatılsın mı? Müzik kumandası çalışmaya devam eder.')) {
          void run('signout', onSignOut)
        }
      }}><LogOut />{busyDeviceId === 'signout' ? 'Oturum kapatılıyor…' : 'Bu cihazdan çıkış yap'}</button>
      <p className="mobile-settings-note">Çıkış yapmak YouTube Music oturumunu, PC eşlemesini veya yerel müzik kumandasını etkilemez.</p>
    </div>
  )
}
