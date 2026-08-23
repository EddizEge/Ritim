const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createDevicePreferences, normalizeDevicePreferences } = require('../electron/device-preferences.cjs')

test('cihaz bildirim tercihi yerel dosyada kalır ve tekrar açıldığında korunur', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ritim-device-preferences-'))
  try {
    const first = createDevicePreferences(directory)
    assert.equal(first.read().socialNotificationsEnabled, false)
    first.update({ socialNotificationsEnabled: true, deliveredSocialNotificationIds: ['a', 'a', 'b'] })
    first.update({ deliveredSocialNotificationIds: ['a', 'b', 'c'] })

    const reopened = createDevicePreferences(directory)
    assert.deepEqual(reopened.read(), {
      socialNotificationsEnabled: true,
      deliveredSocialNotificationIds: ['a', 'b', 'c'],
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('bozuk cihaz tercihleri güvenli varsayılanlara normalize edilir', () => {
  assert.deepEqual(normalizeDevicePreferences({
    socialNotificationsEnabled: 'yes',
    deliveredSocialNotificationIds: [1, 'ok', 'x'.repeat(121)],
  }), {
    socialNotificationsEnabled: false,
    deliveredSocialNotificationIds: ['ok'],
  })
})
