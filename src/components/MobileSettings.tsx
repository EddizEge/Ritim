import { useState } from 'react'
import { AlertCircle, Bell, Eye, Laptop, LogOut, RefreshCw, ShieldCheck, Smartphone, UserRoundX, VolumeX } from 'lucide-react'
import type { SocialAccountState } from '../hooks/useSocialAccount'
import type { SocialActions, SocialState } from '../social/types'

type Props = {
  account: SocialAccountState
  onRefresh: () => Promise<unknown>
  onReconnect: () => Promise<unknown>
  onRevokeDevice: (deviceId: string) => Promise<void>
  onSignOut: () => Promise<void>
  social: SocialState
  socialActions: SocialActions
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

export function MobileSettings({ account, onRefresh, onReconnect, onRevokeDevice, onSignOut, social, socialActions }: Props) {
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

      <section className="mobile-settings-section">
        <header><div><Eye /><span><h2>Sosyal görünürlük</h2><p>Aynı hesaptaki bütün cihazlara uygulanır.</p></span></div><em>Hesap</em></header>
        <label><span><b>Profil görünürlüğü</b><small>Adın, avatarın ve çevrimiçi durumun.</small></span><select value={social.privacy.profileVisibility} onChange={(event) => socialActions.updatePrivacy({ ...social.privacy, profileVisibility: event.target.value as SocialState['privacy']['profileVisibility'] })}><option value="everyone">Herkes</option><option value="contacts">Mesajlaştıklarım</option><option value="hidden">Gizli</option></select></label>
        <label><span><b>Dinleme görünürlüğü</b><small>Çalan parça ve oda erişimin.</small></span><select value={social.privacy.listeningVisibility} onChange={(event) => socialActions.updatePrivacy({ ...social.privacy, listeningVisibility: event.target.value as SocialState['privacy']['listeningVisibility'] })}><option value="everyone">Herkes</option><option value="contacts">Mesajlaştıklarım</option><option value="hidden">Gizli</option></select></label>
      </section>

      <section className="mobile-settings-section">
        <header><div><Bell /><span><h2>Bildirimler</h2><p>Mesaj ve tepki ayarları hesapta saklanır.</p></span></div><em>Hesap + cihaz</em></header>
        <label><span><b>Mesajlar</b><small>Mesajlar ve yeni mesaj istekleri.</small></span><input type="checkbox" checked={social.notificationPreferences.messagesEnabled} onChange={(event) => socialActions.updateNotificationPreferences({ ...social.notificationPreferences, messagesEnabled: event.target.checked })} /></label>
        <label><span><b>Tepkiler</b><small>Mesajlarına gelen sosyal tepkiler.</small></span><input type="checkbox" checked={social.notificationPreferences.reactionsEnabled} onChange={(event) => socialActions.updateNotificationPreferences({ ...social.notificationPreferences, reactionsEnabled: event.target.checked })} /></label>
        <button className={social.notificationPreferences.deviceEnabled ? 'is-enabled' : ''} onClick={socialActions.requestDeviceNotifications}><Bell />{social.notificationPreferences.deviceEnabled ? 'Bu telefonda sistem bildirimleri açık' : 'Bu telefonda sistem bildirimlerini aç'}</button>
      </section>

      <section className="mobile-settings-section mobile-moderation-section">
        <header><div><ShieldCheck /><span><h2>Güvenlik</h2><p>Sessize alma, engelleme ve şikâyet özetin.</p></span></div><em>Hesap</em></header>
        <div className="mobile-moderation-group"><h3><VolumeX />Sessize alınanlar <span>{social.mutedUsers.length}</span></h3>{social.mutedUsers.length ? social.mutedUsers.map((user) => <article key={user.id}><span><b>{user.displayName}</b><small>{user.handle}</small></span><button onClick={() => socialActions.toggleMute(user.id)}>Sesi aç</button></article>) : <p>Henüz sessize alınan kullanıcı yok.</p>}</div>
        <div className="mobile-moderation-group"><h3><UserRoundX />Engellenenler <span>{social.blockedUsers.length}</span></h3>{social.blockedUsers.length ? social.blockedUsers.map((user) => <article key={user.id}><span><b>{user.displayName}</b><small>{user.handle}</small></span><button onClick={() => socialActions.blockUser(user.id)}>Engeli kaldır</button></article>) : <p>Henüz engellenen kullanıcı yok.</p>}</div>
        <div className="mobile-report-summary"><h3>Şikâyet geçmişi <span>{social.reportSummary.total}</span></h3>{social.reportSummary.recent.length ? social.reportSummary.recent.map((report, index) => <article key={`${report.targetUserId}-${report.createdAt}-${index}`}><span><b>{report.displayName}</b><small>{report.reason} · {new Date(report.createdAt).toLocaleDateString('tr-TR')}</small></span><em>Alındı</em></article>) : <p>Gönderilmiş şikâyet bulunmuyor.</p>}<small>İnceleme notları ve iç ayrıntılar gösterilmez.</small></div>
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
