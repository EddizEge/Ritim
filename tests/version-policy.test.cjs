const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  androidVersionCode,
  assertTagMatchesVersion,
  parseVersion,
  updateChannel,
} = require('../electron/version-policy.cjs')

test('Beta 1 sürümü ve güncelleme kanalı ayrıştırılır', () => {
  assert.deepEqual(parseVersion('0.9.1-beta.1'), {
    normalized: '0.9.1-beta.1',
    major: 0,
    minor: 9,
    patch: 1,
    prerelease: { channel: 'beta', iteration: 1 },
  })
  assert.equal(updateChannel('0.9.1-beta.1'), 'beta')
  assert.equal(updateChannel('0.9.1'), 'latest')
})

test('Android sürüm kodları alpha, beta, rc ve kararlı sırayı korur', () => {
  const values = [
    androidVersionCode('0.9.1-alpha.1'),
    androidVersionCode('0.9.1-beta.1'),
    androidVersionCode('0.9.1-rc.1'),
    androidVersionCode('0.9.1'),
    androidVersionCode('0.9.2-alpha.1'),
  ]
  assert.deepEqual(values, [90_101, 90_141, 90_181, 90_199, 90_201])
  assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]))
  assert.ok(androidVersionCode('0.9.1-beta.1') > 900)
})

test('yayın etiketi paket sürümüyle birebir eşleşmelidir', () => {
  assert.equal(assertTagMatchesVersion('v0.9.1-beta.1', '0.9.1-beta.1'), true)
  assert.throws(() => assertTagMatchesVersion('v0.9.1-beta.2', '0.9.1-beta.1'))
})

test('desteklenmeyen prerelease biçimleri reddedilir', () => {
  assert.throws(() => parseVersion('0.9.1-preview.1'))
  assert.throws(() => androidVersionCode('0.9.1-beta.40'))
})

test('Windows legacy kurulum geçişi modern sürümlerin kayıt akışını atlamaz', () => {
  const installerInclude = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')

  assert.match(installerInclude, /\$R8 == "0\.7\.0"/)
  assert.match(installerInclude, /\$R8 == "0\.7\.1"/)
  assert.match(installerInclude, /\$R8 == "0\.7\.2"/)
  assert.doesNotMatch(installerInclude, /\$R8 != ""/)
  assert.match(installerInclude, /registryAddInstallInfo/)
})
