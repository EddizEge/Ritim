const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { desktopSocialNotificationContent } = require('../electron/social-notifications.cjs')

const base = { id: 'n', actorId: 'a', createdAt: 1, read: false }

test('Windows bildirimi profile_reaction için "profiline … bıraktı" der; tepki kapalıysa göstermez', () => {
  assert.deepEqual(desktopSocialNotificationContent({ ...base, kind: 'profile_reaction', body: '🔥' }, 'Elif Şahin'), {
    title: 'Elif Şahin profiline 🔥 bıraktı',
    body: '',
  })
  assert.equal(desktopSocialNotificationContent({ ...base, kind: 'profile_reaction', body: '🔥' }, 'Elif', { reactionsEnabled: false, messagesEnabled: true }), null)
  assert.equal(desktopSocialNotificationContent({ ...base, kind: 'reaction', body: '♥' }, 'Selin', { reactionsEnabled: false }), null)
  assert.deepEqual(desktopSocialNotificationContent({ ...base, kind: 'reaction', body: '♥' }, 'Selin', { reactionsEnabled: true }), {
    title: 'Selin mesajına tepki verdi',
    body: '♥ tepkisi',
  })
})

test('mesaj ve istek bildirimleri messagesEnabled izler; bilinmeyen tür hiç gösterilmez', () => {
  assert.deepEqual(desktopSocialNotificationContent({ ...base, kind: 'message', body: 'Naber' }, 'Deniz'), { title: 'Deniz sana yazdı', body: 'Naber' })
  assert.deepEqual(desktopSocialNotificationContent({ ...base, kind: 'message_request', body: 'Selam' }, 'Mert'), { title: 'Mert mesaj isteği gönderdi', body: 'Selam' })
  assert.equal(desktopSocialNotificationContent({ ...base, kind: 'message', body: 'x' }, 'Deniz', { messagesEnabled: false }), null)
  assert.equal(desktopSocialNotificationContent({ ...base, kind: 'message_request', body: 'x' }, 'Mert', { messagesEnabled: false }), null)
  assert.equal(desktopSocialNotificationContent({ ...base, kind: 'room_invite', body: 'x' }, 'Kim'), null)
  assert.equal(desktopSocialNotificationContent(undefined, 'Kim'), null)
})

test('ana süreç Windows bildirimlerini bu modülle üretir', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const deliver = main.slice(main.indexOf('function deliverDesktopSocialNotifications'), main.indexOf('async function startSocialClient'))
  assert.match(deliver, /desktopSocialNotificationContent\(notification, actorName, nextState\.notificationPreferences\)/)
  assert.match(deliver, /if \(!content\) continue/)
  assert.doesNotMatch(deliver, /sana yazdı/)
})

test('Sosyal ayarları kısayolu ayarlar penceresinde ilgili bölümü açar', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'settings-preload.cjs'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'electron', 'settings.js'), 'utf8')
  assert.match(main, /action\.type === 'open-settings'[\s\S]*createSettingsWindow\(action\.payload\.section\)/)
  assert.match(main, /SETTINGS_SECTIONS\.has\(section\)/)
  assert.match(main, /ipcMain\.on\('settings:open', \(\) => createSettingsWindow\(\)\)/)
  assert.match(preload, /on\('settings:open-section', handler\)/)
  assert.match(settings, /onOpenSection\?\.\(\(section\) => \{\s*if \(Object\.hasOwn\(sectionCopy, section\)\) openSection\(section\)/)
})
