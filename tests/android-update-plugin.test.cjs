const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const plugin = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'app', 'ritim', 'mobile', 'RitimUpdatePlugin.java'), 'utf8')
const activity = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'app', 'ritim', 'mobile', 'MainActivity.java'), 'utf8')
const manifest = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')

test('Android güncelleme eklentisi kayıtlıdır ve kurulum iznini açıkça bildirir', () => {
  assert.match(activity, /registerPlugin\(RitimUpdatePlugin\.class\)/)
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/)
  assert.match(plugin, /@CapacitorPlugin\(name = "RitimUpdate"\)/)
})

test('Android indirmesi yalnız kanonik sürümle eşleşen GitHub APKsini kabul eder', () => {
  assert.match(plugin, /"github\.com"\.equalsIgnoreCase\(uri\.getHost\(\)\)/)
  assert.match(plugin, /path\.startsWith\("\/eddizege\/ritim\/releases\/download\/"\)/)
  assert.match(plugin, /urlMatchesVersion\(url, version\)/)
  assert.match(plugin, /fileName\.equals\("Ritim-" \+ version \+ "\.apk"\)/)
})

test('Android DownloadManager ilerlemeyi saklar ve kurulumu kullanıcı onayına bırakır', () => {
  assert.match(plugin, /COLUMN_BYTES_DOWNLOADED_SO_FAR/)
  assert.match(plugin, /COLUMN_TOTAL_SIZE_BYTES/)
  assert.match(plugin, /VISIBILITY_VISIBLE_NOTIFY_COMPLETED/)
  assert.match(plugin, /canRequestPackageInstalls\(\)/)
  assert.match(plugin, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/)
  assert.match(plugin, /Intent\.ACTION_VIEW/)
  assert.match(plugin, /public void clear\(PluginCall call\)/)
})

test('Android eski hedef sürüm indirmesini yeni güncelleme için yeniden kullanmaz', () => {
  assert.match(plugin, /String previousVersion = preferences\(\)\.getString\(TARGET_VERSION, ""\)/)
  assert.match(plugin, /version\.equals\(previousVersion\)/)
  assert.match(plugin, /remove\(DOWNLOAD_ID\)\.remove\(TARGET_VERSION\)\.commit\(\)/)
  assert.match(plugin, /synchronized \(downloadLock\)/)
})

test('Android APK kurulumdan önce paket, sürüm kodu ve imzayla doğrulanır', () => {
  assert.match(plugin, /copyDownloadedApkToPrivateCache\(id, version\)/)
  assert.match(plugin, /verifyDownloadedApk\(privateApk, version\)/)
  assert.match(plugin, /FileProvider\.getUriForFile/)
  assert.match(plugin, /getContext\(\)\.getPackageName\(\)\.equals\(archive\.packageName\)/)
  assert.match(plugin, /versionCode\(archive\) <= versionCode\(installed\)/)
  assert.match(plugin, /signerDigests\(installed\)\.equals\(signerDigests\(archive\)\)/)
  assert.match(plugin, /"UPDATE_APK_INVALID"/)
  assert.match(plugin, /clearStoredDownload\(id, version\)/)
})
