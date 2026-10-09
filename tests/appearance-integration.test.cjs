const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('masaüstü görünüm IPCsi yerel allowlist deposunu ve güvenilir pencereleri kullanır', async () => {
  const mainSource = await fs.readFile(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(mainSource, /createAppearanceStore\(app\.getPath\('userData'\)\)/)
  assert.match(mainSource, /appearance:\s*appearanceStore\.read\(\)/)

  const setterStart = mainSource.indexOf("ipcMain.handle('settings:set-appearance'")
  const setterEnd = mainSource.indexOf("ipcMain.handle('settings:get-social-account'", setterStart)
  assert.notEqual(setterStart, -1)
  assert.notEqual(setterEnd, -1)
  const setter = mainSource.slice(setterStart, setterEnd)
  assert.match(setter, /event\.sender !== settingsWindow\.webContents/)
  assert.match(setter, /appearanceStore\.update\(normalizeAppearancePreferences\(preferences\)\)/)
  assert.match(setter, /broadcastAppearancePreferences\(next\)/)
  assert.doesNotMatch(setter, /socialSocket|musicView/)

  const readerStart = mainSource.indexOf("ipcMain.handle('shell:get-appearance'")
  const readerEnd = mainSource.indexOf("ipcMain.handle('shell:get-social-summary'", readerStart)
  assert.notEqual(readerStart, -1)
  assert.notEqual(readerEnd, -1)
  const reader = mainSource.slice(readerStart, readerEnd)
  assert.match(reader, /event\.sender !== mainWindow\.webContents/)
  assert.match(reader, /return appearanceStore\.read\(\)/)

  const socialReaderStart = mainSource.indexOf("ipcMain.handle('social:get-appearance'")
  const socialReaderEnd = mainSource.indexOf("ipcMain.handle('social:action'", socialReaderStart)
  assert.notEqual(socialReaderStart, -1)
  assert.notEqual(socialReaderEnd, -1)
  const socialReader = mainSource.slice(socialReaderStart, socialReaderEnd)
  assert.match(socialReader, /isTrustedSocialSender\(event\)/)
  assert.match(socialReader, /return appearanceStore\.read\(\)/)

  const broadcastStart = mainSource.indexOf('function broadcastAppearancePreferences(')
  assert.notEqual(broadcastStart, -1)
  const broadcast = mainSource.slice(broadcastStart, mainSource.indexOf('\n}\n', broadcastStart))
  assert.match(broadcast, /'shell:appearance'/)
  assert.match(broadcast, /sendToSocialView\('social:appearance', preferences\)/)
  assert.match(broadcast, /'settings:appearance'/)
})

test('preload köprüleri yalnız gerekli görünüm kanallarını açar', async () => {
  const [settingsPreload, shellPreload, socialPreload] = await Promise.all([
    fs.readFile(path.join(root, 'electron', 'settings-preload.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell-preload.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'social-preload.cjs'), 'utf8'),
  ])
  assert.match(settingsPreload, /invoke\('settings:set-appearance', preferences\)/)
  assert.match(settingsPreload, /on\('settings:appearance', handler\)/)
  assert.match(shellPreload, /invoke\('shell:get-appearance'\)/)
  assert.match(shellPreload, /on\('shell:appearance', listener\)/)
  assert.match(socialPreload, /invoke\('social:get-appearance'\)/)
  assert.match(socialPreload, /subscribe\('social:appearance', callback\)/)
})

test('ayarlar görünüm seçeneklerini Bu cihaz kapsamında sunar ve üç renderer canlı uygular', async () => {
  const [settingsHtml, settingsSource, shellSource, settingsCss, shellCss, socialHook, sharedCss, socialCss] = await Promise.all([
    fs.readFile(path.join(root, 'electron', 'settings.html'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'settings.js'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell.js'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'settings.css'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell.css'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'desktopSocial', 'useDesktopSocialBridge.ts'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'styles.css'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'desktopSocial', 'desktopSocial.css'), 'utf8'),
  ])
  for (const id of ['appearance-theme', 'appearance-density', 'appearance-motion', 'appearance-artwork']) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`))
  }
  assert.match(settingsHtml, /data-panel="appearance"[\s\S]*?scope-pill">Bu cihaz</)
  for (const value of ['system', 'dark', 'black', 'comfortable', 'compact', 'reduced', 'full', 'hidden']) {
    assert.match(settingsHtml, new RegExp(`value="${value}"`))
  }
  assert.match(settingsSource, /settingsApi\?\.onAppearance\(applyAppearancePreferences\)/)
  assert.match(shellSource, /window\.ritimShell\?\.onAppearance\(applyAppearancePreferences\)/)
  assert.match(shellSource, /getAppearance\(\)\.then\(applyAppearancePreferences\)/)
  for (const source of [settingsSource, shellSource]) {
    assert.match(source, /root\.dataset\.theme/)
    assert.match(source, /root\.dataset\.density/)
    assert.match(source, /root\.dataset\.motion/)
    assert.match(source, /root\.dataset\.artwork/)
  }
  assert.match(settingsCss, /data-resolved-theme="black"/)
  assert.match(settingsCss, /data-density="compact"/)
  assert.match(shellCss, /data-motion="reduced"/)
  assert.match(shellCss, /data-resolved-theme="light"/)

  // The PC Social view (shared React hub) reads the same PC appearance store.
  assert.match(socialHook, /bridge\.onAppearance\(apply\)/)
  assert.match(socialHook, /bridge\.getAppearance\(\)\.then\(apply\)/)
  for (const key of ['ritimTheme', 'ritimDensity', 'ritimMotion', 'ritimArtwork', 'ritimResolvedTheme']) {
    assert.match(socialHook, new RegExp(`root\\.dataset\\.${key} =`))
  }
  assert.match(sharedCss, /html\[data-ritim-artwork='hidden'\] \.social-track-cover/)
  assert.match(sharedCss, /html\[data-ritim-motion='reduced'\]/)
  assert.match(socialCss, /data-ritim-resolved-theme='light'/)
  assert.match(socialCss, /data-ritim-resolved-theme='black'/)
  assert.match(socialCss, /data-ritim-density='compact'/)
  assert.match(socialCss, /data-ritim-artwork='reduced'/)
})

test('gizli kapak tercihi Android medya bildiriminden uzak görseli kaldırır', async () => {
  const [appSource, mediaHook] = await Promise.all([
    fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'src', 'hooks', 'useNativeMediaSession.ts'), 'utf8'),
  ])
  assert.match(appSource, /useNativeMediaSession\([\s\S]*appearance\.artwork\)/)
  assert.match(mediaHook, /previous\.artworkMode === artworkMode/)
  assert.match(mediaHook, /artwork:\s*artworkMode === 'hidden' \? '' : track\.thumbnailUrl/)
  assert.match(mediaHook, /\[artworkMode, connected,/)
})
