import { useReducer } from 'react'
import { pairingRecoveryReducer, type PairingRecoveryView } from '../pairingRecovery'

// Shown when the saved pairing could not be read from the Android Keystore.
// "Tekrar dene" reads it again; "Yeniden eşle" (after a confirmation) forgets
// it and opens the QR pairing screen (src/pairingRecovery.ts).
export function PairingUnreadable({ onRetry, onRepair, initialView = 'unreadable' }: {
  onRetry: () => void
  onRepair: () => Promise<unknown>
  initialView?: PairingRecoveryView
}) {
  const [view, dispatch] = useReducer(pairingRecoveryReducer, initialView)

  if (view === 'unreadable') {
    return (
      <main className="native-pairing-shell">
        <section className="native-pairing-card" role="alert">
          <p>Kayıtlı PC eşlemesi şu an okunamadı. Eşleme silinmedi; telefonun kilidini açıp tekrar dene.</p>
          <button type="button" className="native-scan-button" onClick={onRetry}>Tekrar dene</button>
          <button type="button" className="native-update-button" onClick={() => dispatch('ask-repair')}>Yeniden eşle</button>
        </section>
      </main>
    )
  }

  const resetting = view === 'resetting'
  return (
    <main className="native-pairing-shell">
      <section className="native-pairing-card" role="alertdialog" aria-labelledby="pairing-repair-question">
        <p id="pairing-repair-question">Kayıtlı eşleme silinip yeni QR ile eşleşeceksin. Devam?</p>
        <div className="native-pairing-choice">
          <button type="button" className="native-pairing-cancel" disabled={resetting} onClick={() => dispatch('cancel')}>İptal</button>
          <button
            type="button"
            className="native-pairing-confirm"
            disabled={resetting}
            onClick={() => {
              dispatch('confirm')
              void onRepair()
            }}
          >
            {resetting ? 'Siliniyor…' : 'Yeniden eşle'}
          </button>
        </div>
      </section>
    </main>
  )
}
