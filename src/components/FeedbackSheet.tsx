import { FormEvent, useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Bug, ExternalLink, X } from 'lucide-react'
import { isNativeMobile, readMobilePairing } from '../mobileConfig'

type Props = {
  open: boolean
  onClose: () => void
  connected: boolean
  peerCount: number
  room: string
  pairingError: string
  trackTitle: string
  trackId: string
}

const repositoryUrl = 'https://github.com/EddizEge/Ritim'

async function openExternal(url: string) {
  if (isNativeMobile) await Browser.open({ url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export function FeedbackSheet({ open, onClose, connected, peerCount, room, pairingError, trackTitle, trackId }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [category, setCategory] = useState('Oynatıcı')
  const [version, setVersion] = useState('web')

  useEffect(() => {
    if (!open || !isNativeMobile) return
    void CapacitorApp.getInfo().then((info) => setVersion(info.version)).catch(() => setVersion('bilinmiyor'))
  }, [open])

  if (!open) return null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !description.trim()) return
    const paired = readMobilePairing()
    const diagnostics = [
      `- Ritim sürümü: ${version}`,
      `- Platform: ${isNativeMobile ? 'Android' : 'Web'}`,
      `- PC bağlantısı: ${connected ? `Bağlı (${peerCount} cihaz)` : `Çevrimdışı${pairingError ? ` — ${pairingError}` : ''}`}`,
      `- Oda: ${room}`,
      `- PC adresi: ${paired?.syncUrl || 'Web önizleme'}`,
      `- Parça: ${trackTitle} (${trackId})`,
      `- Ekran: ${window.innerWidth}x${window.innerHeight}`,
      `- Kullanıcı aracısı: ${navigator.userAgent}`,
    ].join('\n')
    const body = `## Sorun\n${description.trim()}\n\n## Tekrarlama adımları\n${steps.trim() || 'Belirtilmedi'}\n\n## Teknik bilgiler\n${diagnostics}\n\n> GitHub ekranında istersen ekran görüntüsü de ekleyebilirsin.`
    const params = new URLSearchParams({
      title: `[${category}] ${title.trim()}`,
      body,
      labels: 'bug',
    })
    void openExternal(`${repositoryUrl}/issues/new?${params.toString()}`)
  }

  return (
    <div className="feedback-overlay" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
      <header>
        <button type="button" onClick={onClose} aria-label="Hata bildirimini kapat"><X /></button>
        <div><small>RİTİM GERİ BİLDİRİM</small><h1 id="feedback-title">Hata bildir</h1></div>
      </header>
      <form onSubmit={submit}>
        <p>Rapor GitHub’da düzenlenebilir bir kayıt olarak açılır. Böylece durumunu takip edip sonradan bilgi ekleyebilirsin.</p>
        <label>Kategori<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Oynatıcı</option><option>Bağlantı</option><option>Arama ve gezinme</option><option>Şarkı sözleri</option><option>Görsel sorun</option><option>Diğer</option></select></label>
        <label>Kısa başlık<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Örn. Sonraki şarkı düğmesi çalışmıyor" /></label>
        <label>Ne oldu?<textarea required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Gördüğün sorunu ve beklediğin davranışı yaz" /></label>
        <label>Nasıl tekrarlanıyor?<textarea value={steps} onChange={(event) => setSteps(event.target.value)} placeholder={'1. ...\n2. ...\n3. ...'} /></label>
        <div className="feedback-diagnostics"><Bug /><span><b>Teknik bilgiler otomatik eklenecek</b><small>Sürüm, bağlantı durumu, ekran ve çalan parça; güvenlik anahtarı eklenmez.</small></span></div>
        <button className="feedback-submit" type="submit" disabled={!title.trim() || !description.trim()}>GitHub’da raporu aç <ExternalLink /></button>
        <button className="feedback-history" type="button" onClick={() => void openExternal(`${repositoryUrl}/issues`)}>Bildirilen sorunları gör</button>
      </form>
    </div>
  )
}
