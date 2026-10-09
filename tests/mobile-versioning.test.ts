import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsPrereleaseUpdates,
  compareRitimVersions,
  isNewerRitimVersion,
  ritimReleaseLabel,
} from '../src/versioning'
import {
  githubReleasesApiUrl,
  acceptsReleaseForChannel,
  mobileUpdateChannel,
  normalizeGitHubRepository,
  safeMobileUpdateAssetUrl,
  selectMobileRelease,
} from '../src/mobileUpdatePolicy'

test('mobil sürüm karşılaştırması semver prerelease sırasını korur', () => {
  assert.equal(compareRitimVersions('0.9.1-beta.2', '0.9.1-beta.1'), 1)
  assert.equal(compareRitimVersions('0.9.1-rc.1', '0.9.1-beta.9'), 1)
  assert.equal(compareRitimVersions('0.9.1', '0.9.1-rc.9'), 1)
  assert.equal(isNewerRitimVersion('0.9.1-beta.1', '0.9.0'), true)
})

test('yalnızca eski Alpha geçişi ve prerelease istemciler Beta güncellemelerini kabul eder', () => {
  assert.equal(acceptsPrereleaseUpdates('0.9.0'), true)
  assert.equal(acceptsPrereleaseUpdates('0.9.1-beta.1'), true)
  assert.equal(acceptsPrereleaseUpdates('0.9.1'), false)
})

test('mobil güncelleyici en yeni uygun yayını ve doğru kanalı seçer', () => {
  const release = selectMobileRelease([
    { tag_name: 'v0.9.1-beta.2', prerelease: true },
    { tag_name: 'v0.9.1-beta.3', prerelease: true, draft: true },
    { tag_name: 'v0.9.1', prerelease: false },
  ], '0.9.1-beta.1')
  assert.equal(release?.tag_name, 'v0.9.1')
  assert.equal(mobileUpdateChannel('0.9.1-beta.1'), 'beta')
  assert.equal(mobileUpdateChannel('0.9.1'), 'latest')
})

test('Beta kanalı daha yeni bir Alpha dalına yanlışlıkla geçmez', () => {
  const release = selectMobileRelease([
    { tag_name: 'v0.10.0-alpha.1', prerelease: true },
    { tag_name: 'v0.9.1-beta.2', prerelease: true },
  ], '0.9.1-beta.1')
  assert.equal(release?.tag_name, 'v0.9.1-beta.2')

  const stableRelease = selectMobileRelease([
    { tag_name: 'v0.10.0-beta.1', prerelease: true },
    { tag_name: 'v0.9.2', prerelease: false },
  ], '0.9.1')
  assert.equal(stableRelease?.tag_name, 'v0.9.2')
})

test('kalıcı indirme kaydı mevcut kanal politikasını aşamaz', () => {
  assert.equal(acceptsReleaseForChannel('0.9.2-beta.1', '0.9.1'), false)
  assert.equal(acceptsReleaseForChannel('0.9.2', '0.9.1'), true)
  assert.equal(acceptsReleaseForChannel('0.9.1-rc.1', '0.9.1-beta.1'), true)
  assert.equal(acceptsReleaseForChannel('0.9.1-alpha.9', '0.9.1-beta.1'), false)
})

test('mobil yayın sorgusu yüz kayıtlık sayfaları ve güvenli depo adını kullanır', () => {
  assert.equal(normalizeGitHubRepository('../evil'), 'EddizEge/Ritim')
  assert.equal(githubReleasesApiUrl('EddizEge/Ritim', 2), 'https://api.github.com/repos/EddizEge/Ritim/releases?per_page=100&page=2')
})

test('mobil güncelleme yalnız kanonik GitHub APK varlığını kabul eder', () => {
  const valid = 'https://github.com/EddizEge/Ritim/releases/download/v0.9.1-beta.2/Ritim-Android-v0.9.1-beta.2.apk'
  assert.equal(safeMobileUpdateAssetUrl(valid, 'EddizEge/Ritim', '0.9.1-beta.2'), valid)
  assert.equal(safeMobileUpdateAssetUrl(valid, 'EddizEge/Ritim', '0.9.1-beta.3'), '')
  assert.equal(safeMobileUpdateAssetUrl('https://github.com/EddizEge/Ritim/releases/download/v0.9.1-beta.2/other.apk', 'EddizEge/Ritim', '0.9.1-beta.2'), '')
  assert.equal(safeMobileUpdateAssetUrl('http://github.com/EddizEge/Ritim/releases/download/v1/app.apk', 'EddizEge/Ritim'), '')
  assert.equal(safeMobileUpdateAssetUrl('https://evil.example/Ritim.apk', 'EddizEge/Ritim'), '')
  assert.equal(safeMobileUpdateAssetUrl('https://github.com/Other/Ritim/releases/download/v1/app.apk', 'EddizEge/Ritim'), '')
  assert.equal(safeMobileUpdateAssetUrl('https://github.com/EddizEge/Ritim/releases/tag/v1', 'EddizEge/Ritim'), '')
})

test('Ayarlar sürüm etiketi paket sürümünden türetilir', () => {
  assert.equal(ritimReleaseLabel('0.9.1-beta.2'), 'Beta 2')
  assert.equal(ritimReleaseLabel('v0.9.1-rc.1'), 'RC 1')
  assert.equal(ritimReleaseLabel('0.9.1-alpha.4'), 'Alpha 4')
  assert.equal(ritimReleaseLabel('0.9.1'), 'Kararlı')
  assert.equal(ritimReleaseLabel('geçersiz'), '')
})
