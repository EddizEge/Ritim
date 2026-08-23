const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

test('güncelleme IPC çağrıları yalnız yerel üst seviye Ayarlar penceresinden kabul edilir', () => {
  assert.match(mainSource, /senderFrame === event\.sender\.mainFrame/)
  assert.match(mainSource, /senderFrame\?\.url === SETTINGS_PAGE_URL/)
  assert.match(mainSource, /settings:check-updates'[\s\S]*isTrustedSettingsSender\(event\)/)
  assert.match(mainSource, /settings:download-update'[\s\S]*isTrustedSettingsSender\(event\)/)
  assert.match(mainSource, /settings:install-update'[\s\S]*isTrustedSettingsSender\(event\)/)
})

test('Ayarlar penceresi yerel sayfa dışındaki gezinme ve yönlendirmeleri engeller', () => {
  assert.match(mainSource, /webContents\.on\('will-navigate'[\s\S]*url !== SETTINGS_PAGE_URL[\s\S]*preventDefault/)
  assert.match(mainSource, /webContents\.on\('will-redirect'[\s\S]*url !== SETTINGS_PAGE_URL[\s\S]*preventDefault/)
})

test('kurulum hazırlığı çalışan uygulamayı erken kapatmaz', () => {
  const start = mainSource.indexOf('async function prepareForUpdate()')
  const end = mainSource.indexOf('function isTrustedSettingsSender', start)
  const preparation = mainSource.slice(start, end)
  assert.doesNotMatch(preparation, /destroy\(|stopRuntime\(|releaseSingleInstanceLock|isShuttingDown\s*=\s*true/)
})
