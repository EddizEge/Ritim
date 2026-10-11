const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DEFAULT_LIMIT, REFERENCE_INSTALL_ROOT, measurePackagePaths } = require('../build/check-package-paths.cjs')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('masaüstü paketi telefon paketlerini ve node-gyp ara dosyalarını dışarıda bırakır', () => {
  const config = require('../electron-builder.config.cjs')
  for (const pattern of ['!node_modules/@capacitor/**', '!node_modules/@capacitor-mlkit/**', '!node_modules/**/build/Release/obj/**']) {
    assert.ok(config.files.includes(pattern), pattern)
  }
  assert.equal(config.appId, 'app.ritim.desktop')
  assert.equal(config.artifactName, 'Ritim-Setup-${version}.${ext}')
})

test('Electron ana süreci telefon paketlerini yüklemez', () => {
  const sources = ['electron', 'shared'].flatMap((directory) => fs.readdirSync(path.join(root, directory))
    .filter((file) => /\.(c?js|json)$/.test(file))
    .map((file) => path.join(directory, file)))
  assert.ok(sources.includes(path.join('electron', 'main.cjs')))
  for (const file of sources) {
    assert.doesNotMatch(read(file), /@capacitor/, `${file} telefon paketine bağlanmamalı`)
  }
})

test('yol ölçümü kurulum köküyle birlikte en uzun dosyayı bulur ve sınırı aşanları listeler', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ritim-package-paths-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'resources'))
  fs.writeFileSync(path.join(directory, 'Ritim.exe'), '')
  fs.writeFileSync(path.join(directory, 'resources', 'app.asar'), '')
  const shallow = measurePackagePaths(directory)
  assert.equal(shallow.fileCount, 2)
  assert.equal(shallow.longest.installedPath, `${REFERENCE_INSTALL_ROOT}\\resources\\app.asar`)
  assert.deepEqual(shallow.tooLong, [])

  const deepSegments = ['resources', 'app.asar.unpacked', 'node_modules', '@capacitor', 'android', 'capacitor', 'build', 'intermediates']
  fs.mkdirSync(path.join(directory, ...deepSegments), { recursive: true })
  fs.writeFileSync(path.join(directory, ...deepSegments, `${'x'.repeat(60)}.class`), '')
  const deep = measurePackagePaths(directory)
  assert.equal(DEFAULT_LIMIT, 200)
  assert.ok(deep.longest.length > DEFAULT_LIMIT)
  assert.equal(deep.tooLong.length, 1)
  assert.match(deep.tooLong[0].relativePath, /@capacitor/)
})

test('yayın iş akışı kurucu derlemesinden sonra yol uzunluğunu denetler', () => {
  const workflow = read('.github/workflows/release.yml')
  const build = workflow.indexOf('--win nsis --publish never')
  const check = workflow.indexOf('node build/check-package-paths.cjs release/win-unpacked')
  const release = workflow.indexOf('gh release create')
  assert.ok(build > 0 && check > build && release > check)
})

test('kurucu eski kaldırıcıdan önce yalnız iki Capacitor klasörünü yerinde siler', () => {
  const installer = read('build/installer.nsh')
  const macro = installer.slice(installer.indexOf('!macro ritimRemovePhoneOnlyPackages'), installer.indexOf('!macroend'))
  assert.match(macro, /\$\{If\} "\$INSTDIR" != ""/)
  assert.match(macro, /\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(macro, /\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\resources\\app\.asar"/)
  const removals = [...macro.matchAll(/^\s*(RMDir|Delete)\b.*$/gm)].map((match) => match[0].trim())
  assert.deepEqual(removals, [
    'RMDir /r "$INSTDIR\\resources\\app.asar.unpacked\\node_modules\\@capacitor"',
    'RMDir /r "$INSTDIR\\resources\\app.asar.unpacked\\node_modules\\@capacitor-mlkit"',
  ])
  assert.doesNotMatch(macro, /APPDATA|LOCALAPPDATA/)

  const check = installer.slice(installer.indexOf('!macro customCheckAppRunning'))
  const killed = check.indexOf('nsProcess::KillProcess')
  const removed = check.indexOf('!insertmacro ritimRemovePhoneOnlyPackages')
  const legacy = check.indexOf('ReadRegStr $R8')
  assert.ok(killed > 0 && removed > killed && legacy > removed)
})
