import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairingUnreadable } from '../src/components/PairingUnreadable'
import { OfflineBand } from '../src/components/social/StatusViews'
import {
  pairingRecoveryReducer,
  repairUnreadablePairing,
  resetUnreadablePairing,
  type PairingRecoveryView,
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

test('iptal: hiçbir şey silinmez, kart kalır', async () => {
  let view = pairingRecoveryReducer('unreadable', 'ask-repair')
  view = pairingRecoveryReducer(view, 'cancel')
  assert.equal(view, 'unreadable')
  assert.match(card(view), /Tekrar dene/)
  // Confirming from the card itself (without the question) does nothing.
  assert.equal(pairingRecoveryReducer('unreadable', 'confirm'), 'unreadable')
})

test('onay → sıfırlama → eşleme ekranı', async () => {
  const calls: string[] = []
  let view = pairingRecoveryReducer(pairingRecoveryReducer('unreadable', 'ask-repair'), 'confirm')
  assert.equal(view, 'resetting')
  assert.match(card(view), /Siliniyor…/)
  const result = await repairUnreadablePairing({
    clearPairing: async () => { calls.push('pairing') },
    clearSocialIdentity: async () => { calls.push('social') },
  }, () => calls.push('pairing-screen'), quiet)
  assert.deepEqual(calls, ['pairing', 'social', 'pairing-screen'])
  assert.deepEqual(result, { pairingCleared: true, socialCleared: true })
})

test('silme başarısız olsa da eşleme ekranı açılır', async () => {
  const warnings: string[] = []
  let shown = 0
  const result = await repairUnreadablePairing({
    clearPairing: async () => { throw new Error('ProviderException') },
    clearSocialIdentity: async () => { throw new Error('keystore') },
  }, () => { shown += 1 }, (message) => warnings.push(message))
  assert.equal(shown, 1)
  assert.deepEqual(result, { pairingCleared: false, socialCleared: false })
  assert.equal(warnings.length, 2)

  // One failing step does not stop the other.
  const partial = await resetUnreadablePairing({
    clearPairing: async () => { throw new Error('x') },
    clearSocialIdentity: async () => {},
  }, quiet)
  assert.deepEqual(partial, { pairingCleared: false, socialCleared: true })
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
