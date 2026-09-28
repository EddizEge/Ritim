import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { parsePairingLink, type MobilePairingConfig } from './mobileConfig'

const SCAN_ERROR_MESSAGE = 'QR tarama iptal edildi veya kamera açılamadı.'

export async function scanMobilePairingQr(): Promise<MobilePairingConfig> {
  let result
  try {
    result = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode], autoZoom: true })
  } catch {
    throw new Error(SCAN_ERROR_MESSAGE)
  }

  const value = result.barcodes[0]?.rawValue || result.barcodes[0]?.displayValue || ''
  if (!value) throw new Error(SCAN_ERROR_MESSAGE)
  return parsePairingLink(value)
}
