// Way out of the "saved pairing cannot be read" screen (src/App.tsx).
//
// Normally "Tekrar dene" is enough: the Keystore was only locked or busy. On a
// device whose Keystore keeps failing the user would be stuck there, so a
// second, quieter button offers to forget the saved pairing and pair again
// with a new QR code. It runs only after an explicit confirmation, and the
// pairing screen opens even if removing the old records fails.
//
// A Keystore key can stay broken for good while still failing like a locked
// one (UnrecoverableKeyException, KeyStoreException, ProviderException), so
// removing the records is not enough: the new QR could not be saved with the
// same key. The confirmed reset therefore also wipes the whole secure storage
// and its key (RitimSecureStoragePlugin.reset). Nothing else may call it: on
// a temporary failure that would destroy every record.

export type PairingRecoveryView = 'unreadable' | 'confirm' | 'resetting'

export type PairingRecoveryAction = 'ask-repair' | 'cancel' | 'confirm'

export function pairingRecoveryReducer(view: PairingRecoveryView, action: PairingRecoveryAction): PairingRecoveryView {
  if (action === 'ask-repair') return view === 'unreadable' ? 'confirm' : view
  if (action === 'cancel') return view === 'confirm' ? 'unreadable' : view
  return view === 'confirm' ? 'resetting' : view
}

export type PairingResetSteps = {
  clearPairing: () => Promise<unknown>
  clearSocialIdentity: () => Promise<unknown>
  resetSecureStorage: () => Promise<unknown>
}

export type PairingResetResult = { pairingCleared: boolean; socialCleared: boolean; secureStorageReset: boolean }

// Never throws: each step is tried on its own and a failure is only logged.
export async function resetUnreadablePairing(steps: PairingResetSteps, warn: (message: string, error: unknown) => void = console.warn): Promise<PairingResetResult> {
  const result: PairingResetResult = { pairingCleared: false, socialCleared: false, secureStorageReset: false }
  try {
    await steps.clearPairing()
    result.pairingCleared = true
  } catch (error) {
    warn('[Ritim] Okunamayan eşleme kaydı silinemedi:', error)
  }
  try {
    await steps.clearSocialIdentity()
    result.socialCleared = true
  } catch (error) {
    warn('[Ritim] Sosyal kimlik sıfırlanamadı:', error)
  }
  // Last, after the social operations above were cancelled.
  try {
    await steps.resetSecureStorage()
    result.secureStorageReset = true
  } catch (error) {
    warn('[Ritim] Güvenli depolama sıfırlanamadı:', error)
  }
  return result
}

// The confirmed action: reset what can be reset, then always show the pairing
// screen so a new QR code can be scanned.
export async function repairUnreadablePairing(
  steps: PairingResetSteps,
  showPairingScreen: () => void,
  warn?: (message: string, error: unknown) => void,
) {
  const result = await resetUnreadablePairing(steps, warn)
  showPairingScreen()
  return result
}
