// Way out of the "saved pairing cannot be read" screen (src/App.tsx).
//
// Normally "Tekrar dene" is enough: the Keystore was only locked or busy. On a
// device whose Keystore keeps failing the user would be stuck there, so a
// second, quieter button offers to forget the saved pairing and pair again
// with a new QR code. It runs only after an explicit confirmation, and the
// pairing screen opens even if removing the old records fails.

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
}

export type PairingResetResult = { pairingCleared: boolean; socialCleared: boolean }

// Never throws: each step is tried on its own and a failure is only logged.
export async function resetUnreadablePairing(steps: PairingResetSteps, warn: (message: string, error: unknown) => void = console.warn): Promise<PairingResetResult> {
  const result: PairingResetResult = { pairingCleared: false, socialCleared: false }
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
