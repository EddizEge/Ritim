import { Capacitor, registerPlugin } from '@capacitor/core'

export type MobilePairingSecureStorage = {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

export type MobilePairingLocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>

export type MobilePairingConfig = {
  version: 2
  syncUrl: string
  room: string
  token: string
  installationId: string
  computerName: string
  pairedAt: number
}

export type MobilePairingChange =
  | 'initial_pairing'
  | 'unchanged'
  | 'endpoint_refresh'
  | 'same_computer_reauthorization'
  | 'switch_computer'

type StoredPairingMetadata = Omit<MobilePairingConfig, 'token'> & { transactionId?: string }
type SecurePairingRecord = {
  storageVersion: 1
  transactionId: string
  pairing: MobilePairingConfig
}

const PAIRING_KEY = 'ritim-mobile-pairing-v2'
const SECURE_PAIRING_KEY = 'pairing.token.v2'
const LEGACY_SERVER_KEY = 'ritim-sync-url'
const LEGACY_ROOM_KEY = 'ritim-room'
const LEGACY_TOKEN_KEY = 'ritim-pairing-token'
const PLAYER_CACHE_KEY = 'ritim-player-cache-v2'
const ACCOUNT_SCOPED_LOCAL_KEYS = [
  'ritim-social-delivered-notifications-v1',
  'ritim-social-phone-id',
]
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const INSTALLATION_ID_PATTERN = /^ritim-[a-z0-9]{1,16}$/

const secureStorageGlobal = globalThis as typeof globalThis & { __ritimSecureStorage?: MobilePairingSecureStorage }
const secureStorage = secureStorageGlobal.__ritimSecureStorage
  || registerPlugin<MobilePairingSecureStorage>('RitimSecureStorage')
secureStorageGlobal.__ritimSecureStorage = secureStorage

export const isNativeMobile = Capacitor.isNativePlatform()

function browserLocalStorage() {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

function safeLocalGet(storage: MobilePairingLocalStorage | undefined, key: string) {
  try { return storage?.getItem(key) || '' } catch { return '' }
}

function safeLocalSet(storage: MobilePairingLocalStorage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value)
    return Boolean(storage)
  } catch {
    return false
  }
}

function safeLocalRemove(storage: MobilePairingLocalStorage | undefined, key: string) {
  try { storage?.removeItem(key) } catch {}
}

function removeLocalKeysWithPrefix(storage: MobilePairingLocalStorage | undefined, prefix: string) {
  try {
    const matches: string[] = []
    for (let index = 0; index < (storage?.length || 0); index += 1) {
      const key = storage?.key(index)
      if (key?.startsWith(prefix)) matches.push(key)
    }
    for (const key of matches) storage?.removeItem(key)
  } catch {}
}

function normalizeSyncUrl(value: string) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bağlantı http veya https olmalı.')
  if (url.username || url.password) throw new Error('PC bağlantısı kullanıcı bilgisi içeremez.')
  return url.origin
}

function normalizeRoom(value: string) {
  const room = value.trim().slice(0, 120)
  if (!room) throw new Error('Linkte oda bilgisi eksik.')
  return room
}

function normalizeToken(value: string) {
  const token = value.trim()
  if (!token) throw new Error('Linkte güvenlik anahtarı eksik.')
  if (!PAIRING_TOKEN_PATTERN.test(token)) throw new Error('Linkteki güvenlik anahtarı geçersiz.')
  return token
}

function deriveInstallationId(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ritim-${(hash >>> 0).toString(36)}`
}

function normalizeInstallationId(value: string | undefined, fallbackSeed: string) {
  const installationId = String(value || '').trim()
  if (!installationId) return deriveInstallationId(fallbackSeed)
  if (!INSTALLATION_ID_PATTERN.test(installationId)) throw new Error('Linkteki Ritim PC kimliği geçersiz.')
  return installationId
}

export function normalizeComputerName(value?: string | null) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return normalized || 'Ritim PC'
}

export function classifyMobilePairingChange(
  current: MobilePairingConfig | null,
  incoming: MobilePairingConfig,
): MobilePairingChange {
  if (!current) return 'initial_pairing'
  if (current.installationId !== incoming.installationId) return 'switch_computer'
  if (current.token !== incoming.token || current.room !== incoming.room) {
    return 'same_computer_reauthorization'
  }
  if (
    current.syncUrl !== incoming.syncUrl
    || current.computerName !== incoming.computerName
    || current.pairedAt !== incoming.pairedAt
  ) {
    return 'endpoint_refresh'
  }
  return 'unchanged'
}

function normalizePairing(config: Partial<MobilePairingConfig>): MobilePairingConfig {
  const token = normalizeToken(config.token || '')
  return {
    version: 2,
    syncUrl: normalizeSyncUrl(config.syncUrl || ''),
    room: normalizeRoom(config.room || ''),
    token,
    installationId: normalizeInstallationId(config.installationId, token),
    computerName: normalizeComputerName(config.computerName),
    pairedAt: Number.isFinite(config.pairedAt) && Number(config.pairedAt) > 0
      ? Math.round(Number(config.pairedAt))
      : Date.now(),
  }
}

function pairingMetadata(pairing: MobilePairingConfig, transactionId?: string): StoredPairingMetadata {
  return {
    version: 2,
    syncUrl: pairing.syncUrl,
    room: pairing.room,
    installationId: pairing.installationId,
    computerName: pairing.computerName,
    pairedAt: pairing.pairedAt,
    ...(transactionId ? { transactionId } : {}),
  }
}

function createTransactionId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function parseMetadata(value: string) {
  if (!value) return null
  try {
    const metadata = JSON.parse(value) as Partial<StoredPairingMetadata>
    return metadata.version === 2 ? metadata : null
  } catch {
    return null
  }
}

function parseSecurePairing(value: string) {
  if (!value.startsWith('{')) return null
  try {
    const record = JSON.parse(value) as Partial<SecurePairingRecord>
    if (record.storageVersion !== 1 || !record.transactionId || !record.pairing) return null
    return {
      transactionId: String(record.transactionId),
      pairing: normalizePairing(record.pairing),
    }
  } catch {
    return null
  }
}

export function createPairingMutationQueue() {
  let operationQueue: Promise<unknown> = Promise.resolve()
  return {
    run<T>(operation: () => Promise<T>) {
      const result = operationQueue.then(operation, operation)
      operationQueue = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

export function createMobilePairingPersistence({
  native,
  local = browserLocalStorage(),
  secure = secureStorage,
  nextTransactionId = createTransactionId,
}: {
  native: boolean
  local?: MobilePairingLocalStorage
  secure?: MobilePairingSecureStorage
  nextTransactionId?: () => string
}) {
  const mutationQueue = createPairingMutationQueue()

  function removeLegacyPairing() {
    safeLocalRemove(local, LEGACY_SERVER_KEY)
    safeLocalRemove(local, LEGACY_ROOM_KEY)
    safeLocalRemove(local, LEGACY_TOKEN_KEY)
  }

  function clearAccountCaches() {
    safeLocalRemove(local, PLAYER_CACHE_KEY)
    for (const key of ACCOUNT_SCOPED_LOCAL_KEYS) safeLocalRemove(local, key)
    removeLocalKeysWithPrefix(local, 'ritim-social-phone-id:')
    removeLocalKeysWithPrefix(local, 'ritim-social-web-id:')
  }

  async function writePairing(config: MobilePairingConfig) {
    const normalized = normalizePairing(config)
    if (native) {
      const transactionId = nextTransactionId()
      const record: SecurePairingRecord = {
        storageVersion: 1,
        transactionId,
        pairing: normalized,
      }
      await secure.set({ key: SECURE_PAIRING_KEY, value: JSON.stringify(record) })
      // The complete authoritative record is protected above. Public metadata
      // is only a recoverable convenience and never contains the token.
      safeLocalSet(local, PAIRING_KEY, JSON.stringify(pairingMetadata(normalized, transactionId)))
    } else if (!safeLocalSet(local, PAIRING_KEY, JSON.stringify(normalized))) {
      throw new Error('Eşleme bilgisi bu tarayıcıda saklanamadı.')
    }
    removeLegacyPairing()
    return normalized
  }

  async function readPairing() {
    const storedValue = safeLocalGet(local, PAIRING_KEY)
    const metadata = parseMetadata(storedValue)

    if (native) {
      const secureValue = (await secure.get({ key: SECURE_PAIRING_KEY })).value || ''
      const secureRecord = parseSecurePairing(secureValue)
      if (secureRecord) {
        if (metadata?.transactionId !== secureRecord.transactionId) {
          safeLocalSet(local, PAIRING_KEY, JSON.stringify(pairingMetadata(secureRecord.pairing, secureRecord.transactionId)))
        }
        removeLegacyPairing()
        return secureRecord.pairing
      }

      // One-time upgrade from early Beta builds that stored only the token in
      // SecureStorage while keeping non-secret metadata in localStorage.
      if (secureValue && metadata) {
        try {
          return await writePairing(normalizePairing({ ...metadata, token: secureValue }))
        } catch {
          // Fall through to the original legacy record without deleting it.
        }
      }
    } else if (storedValue) {
      try { return normalizePairing(JSON.parse(storedValue)) } catch { safeLocalRemove(local, PAIRING_KEY) }
    }

    const syncUrl = safeLocalGet(local, LEGACY_SERVER_KEY)
    const room = safeLocalGet(local, LEGACY_ROOM_KEY)
    const legacyToken = safeLocalGet(local, LEGACY_TOKEN_KEY)
    const secureToken = native ? (await secure.get({ key: SECURE_PAIRING_KEY })).value || '' : ''
    const token = legacyToken || secureToken
    if (!syncUrl || !room || !token) return null

    try {
      return await writePairing(normalizePairing({ syncUrl, room, token, computerName: 'Ritim PC' }))
    } catch {
      return null
    }
  }

  async function clearPairing() {
    if (native) await secure.remove({ key: SECURE_PAIRING_KEY })
    safeLocalRemove(local, PAIRING_KEY)
    removeLegacyPairing()
    clearAccountCaches()
  }

  return {
    read: () => mutationQueue.run(readPairing),
    save: (config: MobilePairingConfig) => mutationQueue.run(() => writePairing(config)),
    clear: () => mutationQueue.run(clearPairing),
    clearAccountCaches,
  }
}

const defaultPairingPersistence = createMobilePairingPersistence({ native: isNativeMobile })

export async function readMobilePairing() {
  return defaultPairingPersistence.read()
}

export async function saveMobilePairing(config: MobilePairingConfig) {
  return defaultPairingPersistence.save(config)
}

export async function clearMobilePairing() {
  return defaultPairingPersistence.clear()
}

export function clearMobilePairingCaches() {
  defaultPairingPersistence.clearAccountCaches()
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
  return normalizePairing({
    syncUrl: target.origin,
    room: target.searchParams.get('room') || '',
    token: target.searchParams.get('token') || '',
    installationId: target.searchParams.get('installationId') || undefined,
    computerName: target.searchParams.get('computerName') || undefined,
  })
}

export function webDevelopmentPairing(): MobilePairingConfig {
  const params = new URLSearchParams(window.location.search)
  const configuredSyncUrl = String(import.meta.env.VITE_SYNC_URL || '').trim()
  const fallbackSyncUrl = `${window.location.protocol}//${window.location.hostname}:8787`
  const token = (params.get('token') || '').trim().slice(0, 2048)
  const room = normalizeRoom(params.get('room') || 'EDIZ-4821')
  return {
    version: 2,
    syncUrl: normalizeSyncUrl(configuredSyncUrl || fallbackSyncUrl),
    room,
    token,
    installationId: normalizeInstallationId(params.get('installationId') || undefined, token || room),
    computerName: normalizeComputerName(params.get('computerName')),
    pairedAt: Date.now(),
  }
}
