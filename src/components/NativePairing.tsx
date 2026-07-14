import { FormEvent, useState } from 'react'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { Download, Link2, QrCode, RefreshCw, Smartphone } from 'lucide-react'
import { parsePairingLink, saveMobilePairing } from '../mobileConfig'
import { useMobileUpdate } from '../hooks/useMobileUpdate'

export function NativePairing() {
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [scanning, setScanning] = useState(false)
  const updates = useMobileUpdate()

  const connect = (value: string) => {
    try {
      saveMobilePairing(parsePairingLink(value))
      window.location.reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Bağlantı kurulamadı.')
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    connect(link)
  }

  const scan = async () => {
    setError('')
    setScanning(true)
    try {
      const result = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode], autoZoom: true })
      const value = result.barcodes[0]?.rawValue || result.barcodes[0]?.displayValue || ''
      if (value) connect(value)
    } catch {
      setError('QR tarama iptal edildi veya kamera açılamadı.')
    } finally {
      setScanning(false)
    }
  }

  const updateAction = async () => {
    const message = updates.updateAvailable ? await updates.openUpdate() : await updates.check()
    setError(message)
  }

  return (
    <main className="native-pairing-shell">
      <section className="native-pairing-card">
        <div className="native-pairing-logo"><i><Smartphone /></i><span>Ritim</span></div>
        <span className="native-pairing-eyebrow">ANDROID UYGULAMASI</span>
        <h1>PC’deki müziğin<br />artık cebinde.</h1>
        <p>Ritim Masaüstü’nde Ayarlar’ı aç, telefon bağlantısı QR kodunu bu uygulamayla tara.</p>
        <button className="native-scan-button" onClick={() => void scan()} disabled={scanning}><QrCode />{scanning ? 'Kamera açılıyor…' : 'QR kodu tara'}</button>
        <div className="native-pairing-divider"><span>veya bağlantıyı yapıştır</span></div>
        <form onSubmit={submit}>
          <label htmlFor="pairing-link"><Link2 />Ritim bağlantısı</label>
          <textarea id="pairing-link" value={link} onChange={(event) => setLink(event.target.value)} placeholder="http://192.168.1.x:8787/?companion=1&room=...&token=..." />
          <button type="submit">PC’ye bağlan</button>
        </form>
        {error ? <div className="native-pairing-message">{error}</div> : null}
        <button className="native-update-button" onClick={() => void updateAction()} disabled={updates.checking}>{updates.updateAvailable ? <Download /> : <RefreshCw />}{updates.checking ? 'Kontrol ediliyor…' : updates.updateAvailable ? `${updates.availableVersion} sürümünü indir` : 'Güncellemeleri kontrol et'}</button>
      </section>
    </main>
  )
}
