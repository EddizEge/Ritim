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
  const readerEnd = mainSource.indexOf("ipcMain.handle('shell:get-social-state'", readerStart)
  const reader = mainSource.slice(readerStart, readerEnd)
  assert.match(reader, /event\.sender !== mainWindow\.webContents/)
  assert.match(reader, /return appearanceStore\.read\(\)/)
})

test('preload köprüleri yalnız gerekli görünüm kanallarını açar', async () => {
  const [settingsPreload, shellPreload] = await Promise.all([
    fs.readFile(path.join(root, 'electron', 'settings-preload.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell-preload.cjs'), 'utf8'),
  ])
  assert.match(settingsPreload, /invoke\('settings:set-appearance', preferences\)/)
  assert.match(settingsPreload, /on\('settings:appearance', handler\)/)
  assert.match(shellPreload, /invoke\('shell:get-appearance'\)/)
  assert.match(shellPreload, /on\('shell:appearance', listener\)/)
})

test('ayarlar görünüm seçeneklerini Bu cihaz kapsamında sunar ve iki renderer canlı uygular', async () => {
  const [settingsHtml, settingsSource, shellSource, settingsCss, shellCss] = await Promise.all([
    fs.readFile(path.join(root, 'electron', 'settings.html'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'settings.js'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell.js'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'settings.css'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'shell.css'), 'utf8'),
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
  assert.match(shellCss, /data-artwork="hidden"/)
  assert.match(shellCss, /data-motion="reduced"/)
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
