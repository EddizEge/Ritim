const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { rollbackValue, runAcknowledgedChange, socialActionErrorMessage } = require('../electron/settings-ack.js')
const { SETTINGS_SOCIAL_ACTIONS, createSettingsSocialActionHandler } = require('../electron/settings-ipc.cjs')
const { createSocialActionBridge, normalizeSocialAction } = require('../electron/social-bridge.cjs')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

function changeHarness(result) {
  const applied = []
  const errors = []
  const successes = []
  const run = () => runAcknowledgedChange({
    previous: 'everyone',
    next: 'hidden',
    apply: (value) => applied.push(value),
    send: async (value) => {
      assert.equal(value, 'hidden')
      if (result instanceof Error) throw result
      return typeof result === 'function' ? result() : result
    },
    onSuccess: (ack) => successes.push(ack),
    onError: (message, code) => errors.push({ message, code }),
  })
  return { run, applied, errors, successes }
}

test('başarılı ack yeni değeri korur', async () => {
  const harness = changeHarness({ ok: true })
  assert.deepEqual(await harness.run(), { ok: true })
  assert.deepEqual(harness.applied, ['hidden'])
  assert.equal(harness.successes.length, 1)
  assert.deepEqual(harness.errors, [])
})

test('sunucu reddederse eski değer döner ve Türkçe hata gösterilir', async () => {
  const harness = changeHarness({ ok: false, code: 'invalid_request' })
  assert.deepEqual(await harness.run(), { ok: false, code: 'invalid_request' })
  assert.deepEqual(harness.applied, ['hidden', 'everyone'])
  assert.equal(harness.errors[0].message, 'Bu değişiklik şu an yapılamıyor. Ayarları yenileyip tekrar dene.')
  const unknown = changeHarness({ ok: false, code: 'forbidden' })
  await unknown.run()
  assert.match(unknown.errors[0].message, /onaylanmadı; eski ayar geri yüklendi/)
})

test('zaman aşımında eski değer döner', async () => {
  const harness = changeHarness({ ok: false, code: 'timeout' })
  await harness.run()
  assert.deepEqual(harness.applied, ['hidden', 'everyone'])
  assert.match(harness.errors[0].message, /zamanında yanıt vermedi/)
})

test('rate_limited için sık değişiklik uyarısı gösterilir', async () => {
  const harness = changeHarness({ ok: false, code: 'rate_limited' })
  await harness.run()
  assert.deepEqual(harness.applied, ['hidden', 'everyone'])
  assert.equal(harness.errors[0].message, 'Çok sık değişiklik yaptın; biraz sonra tekrar dene.')
  assert.equal(socialActionErrorMessage('rate_limited'), harness.errors[0].message)
})

test('IPC hatası ya da boş yanıt da değişikliği geri alır', async () => {
  const thrown = changeHarness(new Error('ipc kapandı'))
  assert.deepEqual(await thrown.run(), { ok: false, code: 'failed' })
  assert.deepEqual(thrown.applied, ['hidden', 'everyone'])
  const empty = changeHarness(undefined)
  assert.deepEqual(await empty.run(), { ok: false, code: 'rejected' })
})

// The Settings page: socialState changes optimistically, and a newer
// settings:social-state may land while the ack is pending.
function pendingChange({ state, previous, next, latest, apply, reply }) {
  let answer
  const sent = new Promise((resolve) => { answer = resolve })
  const run = runAcknowledgedChange({
    previous,
    next,
    latest,
    apply,
    send: () => sent,
    onError: () => {},
  })
  return { run, refuse: () => answer(reply || { ok: false, code: 'timeout' }), state }
}

test('ret: yalnız değişen gizlilik alanı geri döner, bekleme sırasında gelen yeni durum korunur', async () => {
  const page = { privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' } }
  const change = pendingChange({
    previous: { ...page.privacy },
    next: { profileVisibility: 'hidden', listeningVisibility: 'everyone' },
    latest: () => ({ ...page.privacy }),
    apply: (privacy) => { page.privacy = { ...page.privacy, ...privacy } },
  })
  assert.equal(page.privacy.profileVisibility, 'hidden')
  // settings:social-state from the phone: listening visibility changed meanwhile.
  page.privacy = { profileVisibility: 'hidden', listeningVisibility: 'friends' }
  change.refuse()
  assert.deepEqual(await change.run, { ok: false, code: 'timeout' })
  assert.deepEqual(page.privacy, { profileVisibility: 'everyone', listeningVisibility: 'friends' })
})

test('ret: değişen alana bu arada başka bir değer geldiyse o yeni değer kalır', () => {
  const previous = { messagesEnabled: true, reactionsEnabled: true }
  const next = { messagesEnabled: false, reactionsEnabled: true }
  assert.deepEqual(
    rollbackValue(previous, next, { messagesEnabled: false, reactionsEnabled: false }),
    { messagesEnabled: true, reactionsEnabled: false },
  )
  // Server pushed its own value for the failed field: it wins over the snapshot.
  assert.deepEqual(
    rollbackValue({ profileVisibility: 'everyone' }, { profileVisibility: 'hidden' }, { profileVisibility: 'friends' }),
    { profileVisibility: 'friends' },
  )
  assert.equal(rollbackValue('everyone', 'hidden', 'friends'), 'everyone')
})

test('ret: engel listesinden kaldırılan kişi geri gelir, bu arada eklenen kişi silinmez', async () => {
  const a = { id: 'a', displayName: 'A' }
  const b = { id: 'b', displayName: 'B' }
  const c = { id: 'c', displayName: 'C' }
  const d = { id: 'd', displayName: 'D' }
  const page = { blockedUsers: [a, b, c] }
  const previous = page.blockedUsers
  const change = pendingChange({
    previous,
    next: previous.filter((user) => user.id !== 'b'),
    latest: () => page.blockedUsers,
    apply: (users) => { page.blockedUsers = users },
  })
  assert.deepEqual(page.blockedUsers.map((user) => user.id), ['a', 'c'])
  page.blockedUsers = [a, c, d]
  change.refuse()
  await change.run
  assert.deepEqual(page.blockedUsers.map((user) => user.id), ['a', 'b', 'c', 'd'])
  // Already back in the newer list: not added twice.
  assert.deepEqual(rollbackValue([a, b], [a], [b, a]).map((user) => user.id), ['b', 'a'])
})

test('latest verilmezse eski davranış: değişiklikten önceki görüntü geri yüklenir', async () => {
  const applied = []
  await runAcknowledgedChange({
    previous: { x: 1 },
    next: { x: 2 },
    apply: (value) => applied.push(value),
    send: async () => ({ ok: false, code: 'rejected' }),
  })
  assert.deepEqual(applied, [{ x: 2 }, { x: 1 }])
})

function settingsHandler({ connected = true, reply, trusted = true, timeoutMs = 40 } = {}) {
  const emitted = []
  const socket = {
    connected,
    emit(event, payload, callback) {
      emitted.push({ event, payload })
      if (reply !== undefined) setTimeout(() => callback(reply), 1)
    },
  }
  const bridge = createSocialActionBridge({ getSocket: () => socket, timeoutMs })
  const handler = createSettingsSocialActionHandler({
    isTrustedSender: () => trusted,
    // Same path as handleSocialAction in electron/main.cjs for remote actions.
    handleSocialAction: async (type, payload) => {
      const action = normalizeSocialAction(type, payload)
      if (!action.ok) return action
      return bridge.emit(action)
    },
  })
  return { handler, emitted }
}

test('Ayarlar IPC işleyicisi sosyal köprünün ack sonucunu döndürür', async () => {
  const privacy = { profileVisibility: 'contacts', listeningVisibility: 'hidden' }
  const accepted = settingsHandler({ reply: { ok: true } })
  assert.deepEqual(await accepted.handler({}, { type: 'privacy', payload: privacy }), { ok: true })
  assert.deepEqual(accepted.emitted, [{ event: 'social:privacy', payload: privacy }])

  const limited = settingsHandler({ reply: { ok: false, code: 'rate_limited' } })
  assert.deepEqual(await limited.handler({}, { type: 'notification-preferences', payload: { messagesEnabled: false, reactionsEnabled: true } }), { ok: false, code: 'rate_limited' })

  const rejected = settingsHandler({ reply: { ok: false, code: 'conversation_not_found' } })
  assert.deepEqual(await rejected.handler({}, { type: 'mute', payload: { targetUserId: 'kullanici-1' } }), { ok: false, code: 'conversation_not_found' })

  const silent = settingsHandler()
  assert.deepEqual(await silent.handler({}, { type: 'block', payload: { targetUserId: 'kullanici-2' } }), { ok: false, code: 'timeout' })

  const offline = settingsHandler({ connected: false, reply: { ok: true } })
  assert.deepEqual(await offline.handler({}, { type: 'privacy', payload: privacy }), { ok: false, code: 'offline' })
  assert.deepEqual(offline.emitted, [])
})

test('Ayarlar IPC işleyicisi yetkisiz pencereyi ve izinsiz işlemleri reddeder', async () => {
  assert.deepEqual([...SETTINGS_SOCIAL_ACTIONS].sort(), ['block', 'mute', 'notification-preferences', 'privacy'])
  const untrusted = settingsHandler({ trusted: false, reply: { ok: true } })
  assert.deepEqual(await untrusted.handler({}, { type: 'privacy', payload: {} }), { ok: false, code: 'forbidden' })
  const other = settingsHandler({ reply: { ok: true } })
  assert.deepEqual(await other.handler({}, { type: 'message', payload: { targetUserId: 'x', text: 'selam' } }), { ok: false, code: 'unknown_action' })
  assert.deepEqual(await other.handler({}, null), { ok: false, code: 'unknown_action' })
  const invalid = await other.handler({}, { type: 'privacy', payload: { profileVisibility: 'herkes', listeningVisibility: 'hidden' } })
  assert.deepEqual(invalid, { ok: false, code: 'invalid_payload' })
  assert.deepEqual([...untrusted.emitted, ...other.emitted], [])
})

test('Ayarlar penceresi sosyal değişiklikleri ack yolundan gönderir', () => {
  const main = read('electron/main.cjs')
  assert.match(main, /ipcMain\.handle\('settings:social-action', createSettingsSocialActionHandler\(\{\s*isTrustedSender: isTrustedSettingsSender,/)
  assert.doesNotMatch(main, /ipcMain\.on\('settings:social-action'/)
  assert.match(read('electron/settings-preload.cjs'), /sendSocialAction: \(type, payload\) => ipcRenderer\.invoke\('settings:social-action'/)
  const html = read('electron/settings.html')
  assert.ok(html.indexOf('<script src="settings-ack.js"></script>') > 0)
  assert.ok(html.indexOf('settings-ack.js') < html.indexOf('<script src="settings.js"></script>'))
  const settings = read('electron/settings.js')
  const sends = [...settings.matchAll(/sendSocialAction\((?:'([a-z-]+)'|(actionType))/g)].map((match) => match[1] || match[2])
  assert.deepEqual(sends.sort(), ['actionType', 'notification-preferences', 'privacy'])
  assert.doesNotMatch(settings, /settingsApi\?\.sendSocialAction/)
  assert.equal((settings.match(/void runSocialChange\(\{/g) || []).length, 3)
  // Every change rolls back on top of the latest social state.
  assert.equal((settings.match(/\n\s+latest: \(\) => /g) || []).length, 3)
})
