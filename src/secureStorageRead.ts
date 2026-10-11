// Reading the Android secure storage (RitimSecureStoragePlugin.java).
//
// The plugin resolves `{ value: null }` only when there is no record (or a
// permanently corrupt one was discarded). A rejection means the Keystore could
// not be used right now (locked, busy, user not authenticated): the record is
// still there. Treating that as "no record" would reset the pairing or the
// Ritim session for nothing, so reads are retried and then reported as
// SecureStorageUnavailableError instead.

export type SecureStorageGet = (options: { key: string }) => Promise<{ value: string | null; discarded?: boolean }>

export const SECURE_STORAGE_RETRY_DELAYS_MS = [200, 600] as const

export class SecureStorageUnavailableError extends Error {
  readonly code = 'SECURE_STORAGE_UNAVAILABLE'
  constructor(readonly key: string, cause?: unknown) {
    super('Güvenli depolama şu an okunamadı; kayıtlı bilgi korunuyor.')
    this.name = 'SecureStorageUnavailableError'
    if (cause !== undefined) Object.assign(this, { cause })
  }
}

export function isSecureStorageUnavailable(error: unknown): error is SecureStorageUnavailableError {
  return error instanceof SecureStorageUnavailableError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SECURE_STORAGE_UNAVAILABLE')
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function readSecureValue(
  get: SecureStorageGet,
  key: string,
  delaysMs: readonly number[] = SECURE_STORAGE_RETRY_DELAYS_MS,
): Promise<string | null> {
  let lastError: unknown
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    if (attempt > 0) await wait(delaysMs[attempt - 1])
    try {
      const result = await get({ key })
      return typeof result?.value === 'string' ? result.value : null
    } catch (error) {
      lastError = error
    }
  }
  throw new SecureStorageUnavailableError(key, lastError)
}
