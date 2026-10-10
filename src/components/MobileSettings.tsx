import { useState } from 'react'
import { AlertCircle, Bell, Download, ExternalLink, Eye, Images, Info, Laptop, LogOut, Palette, RefreshCw, ShieldCheck, Smartphone, UserRoundX, VolumeX } from 'lucide-react'
import { Browser } from '@capacitor/browser'
import type { SocialAccountState } from '../hooks/useSocialAccount'
import type { SocialActions, SocialState } from '../social/types'
import { useAppearance } from '../appearanceContext'
import type { AppearanceArtwork, AppearanceDensity, AppearanceMotion, AppearanceTheme } from '../appearancePreferences'
import { isNativeMobile } from '../mobileConfig'
import { ritimReleaseLabel } from '../versioning'
import productInfo from '../../shared/product-info.json'

type Props = {
  account: SocialAccountState
  onRefresh: () => Promise<unknown>
  onReconnect: () => Promise<unknown>
  onRevokeDevice: (deviceId: string) => Promise<void>
  onSignOut: () => Promise<void>
  social: SocialState
  socialActions: SocialActions
}

type MobileUpdateView = {
  checking: boolean
  status: string
  message: string
  currentVersion: string
  availableVersion: string
  channel: string
  lastCheckedAt: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  updateAvailable: boolean
  downloadManagedByAndroid: boolean
  check: () => Promise<string>
  openUpdate: () => Promise<string>
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

export function MobileAppearanceSettings() {
  const { preferences, update } = useAppearance()
  return (
    <section className="mobile-settings-section mobile-appearance-section">
      <header><div><Palette /><span><h2>Görünüm</h2><p>Tema, yerleşim ve kapak tercihleri yalnızca bu telefonda saklanır.</p></span></div><em>Bu cihaz</em></header>
      <label><span><b>Tema</b><small>Sistem ayarını izle veya sabit bir koyu görünüm seç.</small></span><select aria-label="Mobil tema" value={preferences.theme} onChange={(event) => update({ theme: event.target.value as AppearanceTheme })}><option value="system">Sistemle aynı</option><option value="dark">Koyu</option><option value="black">OLED siyah</option></select></label>
      <label><span><b>Yoğunluk</b><small>Listeler ve kartlar arasındaki boşluk.</small></span><select aria-label="Mobil görünüm yoğunluğu" value={preferences.density} onChange={(event) => update({ density: event.target.value as AppearanceDensity })}><option value="comfortable">Rahat</option><option value="compact">Kompakt</option></select></label>
      <label><span><b>Hareket</b><small>Geçişleri sistemden al veya en aza indir.</small></span><select aria-label="Mobil hareket ayarı" value={preferences.motion} onChange={(event) => update({ motion: event.target.value as AppearanceMotion })}><option value="system">Sistemle aynı</option><option value="reduced">Azaltılmış</option></select></label>
      <label><span><b>Kapaklar</b><small>Albüm görsellerinin boyutunu ve yüklenmesini yönet.</small></span><select aria-label="Mobil kapak görünümü" value={preferences.artwork} onChange={(event) => update({ artwork: event.target.value as AppearanceArtwork })}><option value="full">Tam</option><option value="reduced">Küçük</option><option value="hidden">Gizli</option></select></label>
      <div className="mobile-appearance-note"><Images /><span><b>Kapaklar gizliyken</b><small>Uzak kapak adresleri mümkün olduğunca arayüze bağlanmaz ve veri kullanımı azalır.</small></span></div>
    </section>
  )
}

async function openProductLink(url: string) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.hostname !== 'github.com') throw new Error('Bu bağlantı güvenli değil.')
  if (isNativeMobile) await Browser.open({ url: target.toString() })
  else window.open(target.toString(), '_blank', 'noopener,noreferrer')
}

export function MobileUpdateAboutSettings({ update }: { update: MobileUpdateView }) {
  const [notice, setNotice] = useState('')
  const channelLabels: Record<string, string> = { alpha: 'Alpha', beta: 'Beta', rc: 'RC', latest: 'Kararlı' }
  const releaseLabel = ritimReleaseLabel(update.currentVersion)
  const lastChecked = update.lastCheckedAt
    ? new Date(update.lastCheckedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Henüz denetlenmedi'
  const runUpdate = async () => {
    try {
      setNotice(update.updateAvailable ? await update.openUpdate() : await update.check())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Güncelleme işlemi açılamadı.')
    }
  }
  const formatBytes = (value: number) => {
    if (!value) return '0 MB'
    return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }
  const runProductLink = async (url: string) => {
    try { await openProductLink(url) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Bağlantı açılamadı.') }
  }
  const links = [
    ['GitHub', productInfo.links.github],
    ['Sürüm notları', productInfo.links.releases],
    ['Gizlilik', productInfo.links.privacy],
    ['Lisanslar', productInfo.links.thirdPartyNotices],
    ['Geri bildirim', productInfo.links.feedback],
  ] as const

  return (
    <>
      <section className="mobile-settings-section mobile-update-section">
        <header><div><RefreshCw /><span><h2>Güncellemeler</h2><p>Android paketi GitHub Releases üzerinden güvenli biçimde denetlenir.</p></span></div><em>Bu cihaz</em></header>
        <dl className="mobile-update-details">
          <div><dt>Yüklü sürüm</dt><dd>{update.currentVersion}</dd></div>
          <div><dt>Bulunan sürüm</dt><dd>{update.availableVersion || '—'}</dd></div>
          <div><dt>Kanal</dt><dd>{channelLabels[update.channel] || update.channel}</dd></div>
          <div><dt>Son denetim</dt><dd>{lastChecked}</dd></div>
        </dl>
        {update.status === 'downloading' ? <div className="mobile-update-progress" role="progressbar" aria-label="APK indirme ilerlemesi" aria-valuemin={0} aria-valuemax={100} aria-valuenow={update.percent}><span style={{ width: `${update.percent}%` }} /><small>{update.percent}% · {formatBytes(update.downloadedBytes)}{update.totalBytes ? ` / ${formatBytes(update.totalBytes)}` : ''}</small></div> : null}
        <button onClick={() => void runUpdate()} disabled={update.checking || update.status === 'downloading' || update.status === 'installing'}>
          {update.updateAvailable ? <Download /> : <RefreshCw />}
          {update.checking ? 'Kontrol ediliyor…'
            : update.status === 'downloading' ? 'Android indiriyor…'
            : update.status === 'installing' ? 'Kurulum açılıyor…'
            : update.status === 'downloaded' ? 'Kurulum ekranını aç'
            : update.updateAvailable ? `${update.availableVersion} sürümünü indir` : 'Güncellemeleri kontrol et'}
        </button>
        {update.message || notice ? <p className="mobile-update-message" role="status">{notice || update.message}</p> : null}
        <p className="mobile-settings-note">APK indirmesini Android indirme yöneticisi yürütür; kurulum her zaman senin onayınla açılır. Uygulama mevcut Ritim verilerini kendiliğinden silmez.</p>
      </section>

      <section className="mobile-settings-section mobile-about-section">
        <header><div><Info /><span><h2>{productInfo.name} hakkında</h2><p>{productInfo.developer} tarafından geliştirildi.</p></span></div>{releaseLabel ? <em>{releaseLabel}</em> : null}</header>
        <p className="mobile-about-description">{productInfo.descriptionTr}</p>
        <p className="mobile-about-disclaimer">{productInfo.disclaimerTr}</p>
        <div className="mobile-about-links">
          {links.map(([label, url]) => <button key={label} onClick={() => void runProductLink(url)}><ExternalLink />{label}</button>)}
        </div>
        <p className="mobile-settings-note">{productInfo.projectLicense}</p>
      </section>
    </>
  )
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

      <section className="mobile-settings-section" id="mobile-settings-social">
        <header><div><Eye /><span><h2>Sosyal görünürlük</h2><p>Aynı hesaptaki bütün cihazlara uygulanır.</p></span></div><em>Hesap</em></header>
        <label><span><b>Profil görünürlüğü</b><small>Adın, avatarın ve çevrimiçi durumun.</small></span><select value={social.privacy.profileVisibility} onChange={(event) => socialActions.updatePrivacy({ ...social.privacy, profileVisibility: event.target.value as SocialState['privacy']['profileVisibility'] })}><option value="everyone">Herkes</option><option value="contacts">Mesajlaştıklarım</option><option value="hidden">Gizli</option></select></label>
        <label><span><b>Dinleme görünürlüğü</b><small>Çalan parça ve oda erişimin.</small></span><select value={social.privacy.listeningVisibility} onChange={(event) => socialActions.updatePrivacy({ ...social.privacy, listeningVisibility: event.target.value as SocialState['privacy']['listeningVisibility'] })}><option value="everyone">Herkes</option><option value="contacts">Mesajlaştıklarım</option><option value="hidden">Gizli</option></select></label>
      </section>

      <section className="mobile-settings-section" id="mobile-settings-notifications">
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
