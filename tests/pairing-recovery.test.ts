import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairingUnreadable } from '../src/components/PairingUnreadable'
import { OfflineBand } from '../src/components/social/StatusViews'
import {
  pairingRecoveryReducer,
  repairUnreadablePairing,
  resetUnreadablePairing,
  type PairingRecoveryAction,
  type PairingRecoveryView,
  type PairingResetSteps,
} from '../src/pairingRecovery'
import type { SocialState } from '../src/social/types'

const noop = () => {}
const quiet = () => {}

function card(initialView: PairingRecoveryView = 'unreadable') {
  return renderToStaticMarkup(h(PairingUnreadable, { onRetry: noop, onRepair: async () => {}, initialView }))
}

test('okunamayan eşleme kartı: Tekrar dene birincil, Yeniden eşle ikincil ve sönük', () => {
  const html = card()
  assert.match(html, /Kayıtlı PC eşlemesi şu an okunamadı/)
  assert.match(html, /<button type="button" class="native-scan-button">Tekrar dene<\/button>/)
  assert.match(html, /<button type="button" class="native-update-button">Yeniden eşle<\/button>/)
  assert.doesNotMatch(html, /Devam\?/)
})

test('Yeniden eşle önce onay ister: İptal ve Yeniden eşle düğmeleri', () => {
  assert.equal(pairingRecoveryReducer('unreadable', 'ask-repair'), 'confirm')
  const html = card('confirm')
  assert.match(html, /Kayıtlı eşleme silinip yeni QR ile eşleşeceksin\. Devam\?/)
  assert.match(html, />İptal<\/button>/)
  assert.match(html, /class="native-pairing-confirm">Yeniden eşle<\/button>/)
  assert.doesNotMatch(html, /Tekrar dene/)
})

// Drives the card the way taps do: the reducer decides the view, and the
// repair (with the secure storage reset) runs only on the confirmed step,
// like the confirm button in src/components/PairingUnreadable.tsx.
async function tap(actions: PairingRecoveryAction[], steps: PairingResetSteps) {
  let view: PairingRecoveryView = 'unreadable'
  for (const action of actions) {
    const next = pairingRecoveryReducer(view, action)
    if (action === 'confirm' && view === 'confirm') await repairUnreadablePairing(steps, noop, quiet)
    view = next
  }
  return view
}

function recordingSteps(calls: string[]): PairingResetSteps {
  return {
    clearPairing: async () => { calls.push('pairing') },
    clearSocialIdentity: async () => { calls.push('social') },
    resetSecureStorage: async () => { calls.push('reset') },
  }
}

test('iptal: hiçbir şey silinmez, güvenli depo sıfırlanmaz, kart kalır', async () => {
  const calls: string[] = []
  const view = await tap(['ask-repair', 'cancel'], recordingSteps(calls))
  assert.equal(view, 'unreadable')
  assert.deepEqual(calls, [])
  assert.match(card(view), /Tekrar dene/)
  // Confirming from the card itself (without the question) does nothing.
  assert.equal(await tap(['confirm'], recordingSteps(calls)), 'unreadable')
  assert.deepEqual(calls, [])
})

test('onay → sıfırlama (kayıtlar, sosyal kimlik, güvenli depo ve anahtarı) → eşleme ekranı', async () => {
  const calls: string[] = []
  assert.equal(await tap(['ask-repair', 'confirm'], recordingSteps(calls)), 'resetting')
  assert.deepEqual(calls, ['pairing', 'social', 'reset'])
  assert.match(card('resetting'), /Siliniyor…/)

  calls.length = 0
  const result = await repairUnreadablePairing(recordingSteps(calls), () => calls.push('pairing-screen'), quiet)
  assert.deepEqual(calls, ['pairing', 'social', 'reset', 'pairing-screen'])
  assert.deepEqual(result, { pairingCleared: true, socialCleared: true, secureStorageReset: true })
})

test('silme başarısız olsa da eşleme ekranı açılır', async () => {
  const warnings: string[] = []
  let shown = 0
  const result = await repairUnreadablePairing({
    clearPairing: async () => { throw new Error('ProviderException') },
    clearSocialIdentity: async () => { throw new Error('keystore') },
    resetSecureStorage: async () => { throw Object.assign(new Error('Android güvenli depolama sıfırlanamadı.'), { code: 'SECURE_STORAGE_RESET_FAILED' }) },
  }, () => { shown += 1 }, (message) => warnings.push(message))
  assert.equal(shown, 1)
  assert.deepEqual(result, { pairingCleared: false, socialCleared: false, secureStorageReset: false })
  assert.equal(warnings.length, 3)

  // One failing step does not stop the others.
  const partial = await resetUnreadablePairing({
    clearPairing: async () => { throw new Error('x') },
    clearSocialIdentity: async () => {},
    resetSecureStorage: async () => {},
  }, quiet)
  assert.deepEqual(partial, { pairingCleared: false, socialCleared: true, secureStorageReset: true })
})

test('güvenli depo sıfırlaması yalnız onaylı Yeniden eşle yolundan çağrılır', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const callers: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && /resetMobileSecureStorage\(|secure\.reset\(|secureStorage\.reset\(/.test(fs.readFileSync(full, 'utf8'))) {
        callers.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(root, 'src'))
  assert.deepEqual(callers.sort(), ['src/App.tsx', 'src/mobileConfig.ts'])
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.equal(app.match(/resetMobileSecureStorage\(/g)?.length, 1)
  assert.match(app, /onRepair=\{\(\) => repairUnreadablePairing\(\{[\s\S]*?resetSecureStorage: \(\) => enqueuePairingMutation\(\(\) => resetMobileSecureStorage\(\)\)/)

  // Native side: get() keeps the record on a temporary failure and never resets.
  const plugin = fs.readFileSync(path.join(root, 'android/app/src/main/java/app/ritim/mobile/RitimSecureStoragePlugin.java'), 'utf8')
  const getBody = plugin.slice(plugin.indexOf('public void get('), plugin.indexOf('public void remove('))
  assert.doesNotMatch(getBody, /reset|\.clear\(\)/)
  const resetStart = plugin.indexOf('public void reset(PluginCall call)')
  assert.ok(resetStart > 0)
  const resetBody = plugin.slice(resetStart)
  assert.match(resetBody, /edit\(\)\.clear\(\)\.commit\(\)/)
  assert.match(resetBody, /deleteSecretKeyOrThrow/)
  // Logs carry error classes only, never keys or values.
  for (const line of resetBody.split('\n').filter((entry) => /Log\.[a-z]\(/.test(entry))) {
    assert.doesNotMatch(line, /\bkey\b|value|call\./, line)
  }
})

function socialState(patch: Partial<SocialState>): SocialState {
  return {
    connectionStatus: 'offline',
    currentUser: { id: 'me', displayName: 'Ediz', handle: '@ediz', initials: 'E', avatarTone: 0, presence: 'online', reactionCount: 0 },
    privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' },
    currentDeviceCount: 1,
    companionConnected: true,
    users: [],
    rooms: [],
    roomMessages: {},
    roomReactions: {},
    conversations: {},
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    mutedUserIds: [],
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
    selectedUserId: '',
    ...patch,
  }
}

test('sosyal oturum okunamazsa sosyal ekranda anlaşılır hata ve Tekrar dene; kumanda çalışıyor denir', () => {
  const html = renderToStaticMarkup(h(OfflineBand, { state: socialState({ connectionIssue: 'secure-storage' }), onReconnect: noop }))
  assert.match(html, /Sosyal oturum bu telefonda şu an okunamadı/)
  assert.match(html, /Oturum silinmedi/)
  assert.match(html, /kumandası çalışmaya devam ediyor/)
  assert.match(html, /Tekrar dene<\/button>/)
  const plain = renderToStaticMarkup(h(OfflineBand, { state: socialState({}), onReconnect: noop }))
  assert.match(plain, /Ritim Sosyal’e ulaşılamıyor/)
  assert.match(plain, /Yeniden bağlan<\/button>/)
})
