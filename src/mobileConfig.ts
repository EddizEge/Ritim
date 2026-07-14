import { Capacitor } from '@capacitor/core'

export type MobilePairingConfig = {
  syncUrl: string
  room: string
  token: string
}

const SERVER_KEY = 'ritim-sync-url'
const ROOM_KEY = 'ritim-room'
const TOKEN_KEY = 'ritim-pairing-token'

export const isNativeMobile = Capacitor.isNativePlatform()

export function readMobilePairing(): MobilePairingConfig | null {
  const syncUrl = localStorage.getItem(SERVER_KEY) || ''
  const room = localStorage.getItem(ROOM_KEY) || ''
  const token = localStorage.getItem(TOKEN_KEY) || ''
  return syncUrl && room && token ? { syncUrl, room, token } : null
}

export function parsePairingLink(value: string): MobilePairingConfig {
  const raw = value.trim()
  if (!raw) throw new Error('PC’deki Ritim bağlantı linkini gir.')
  const incoming = new URL(raw)
  let target = incoming
  if (incoming.protocol === 'ritim:') {
    const nested = incoming.searchParams.get('url')
    if (!nested) throw new Error('Bu Ritim QR kodu geçerli değil.')
    target = new URL(nested)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Bağlantı http veya https olmalı.')
  const room = target.searchParams.get('room') || ''
  const token = target.searchParams.get('token') || ''
  if (!room || !token) throw new Error('Linkte oda veya güvenlik anahtarı eksik.')
  return { syncUrl: target.origin, room, token }
}

export function saveMobilePairing(config: MobilePairingConfig) {
  localStorage.setItem(SERVER_KEY, config.syncUrl)
  localStorage.setItem(ROOM_KEY, config.room)
  localStorage.setItem(TOKEN_KEY, config.token)
}

export function clearMobilePairing() {
  localStorage.removeItem(SERVER_KEY)
  localStorage.removeItem(ROOM_KEY)
  localStorage.removeItem(TOKEN_KEY)
}
