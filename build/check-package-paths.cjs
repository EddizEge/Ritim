// Fails when an unpacked Windows build contains a file whose installed path
// would be too long. electron-builder's old uninstaller first moves every file
// to "%TEMP%\nsXXXX.tmp\old-install\...", 13-14 characters longer than the
// install path; past MAX_PATH (260) the move fails and the update aborts with
// "Failed to uninstall old application files: 2" (see build/installer.nsh).
//
// Usage: node build/check-package-paths.cjs [release/win-unpacked] [--limit 200]
const fs = require('node:fs')
const path = require('node:path')

// Per-user one-click install root for the longest Windows user name (20).
const REFERENCE_INSTALL_ROOT = path.win32.join('C:\\', 'Users', 'x'.repeat(20), 'AppData', 'Local', 'Programs', 'ritim')
const DEFAULT_LIMIT = 200

function listFiles(directory, segments = []) {
  const files = []
  for (const entry of fs.readdirSync(path.join(directory, ...segments), { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...listFiles(directory, [...segments, entry.name]))
    else files.push([...segments, entry.name])
  }
  return files
}

function measurePackagePaths(directory, { installRoot = REFERENCE_INSTALL_ROOT, limit = DEFAULT_LIMIT } = {}) {
  const files = listFiles(directory).map((segments) => {
    const relativePath = path.win32.join(...segments)
    const installedPath = path.win32.join(installRoot, relativePath)
    return { relativePath, installedPath, length: installedPath.length }
  }).sort((left, right) => right.length - left.length)
  return {
    fileCount: files.length,
    longest: files[0] || null,
    tooLong: files.filter((file) => file.length > limit),
    limit,
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const limitIndex = args.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number(args.splice(limitIndex, 2)[1]) : DEFAULT_LIMIT
  const directory = path.resolve(args[0] || path.join('release', 'win-unpacked'))
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('--limit pozitif bir tam sayı olmalı.')
    process.exit(2)
  }
  if (!fs.existsSync(directory)) {
    console.error(`Paket klasörü bulunamadı: ${directory}`)
    process.exit(2)
  }
  const result = measurePackagePaths(directory, { limit })
  console.log(`${result.fileCount} dosya; en uzun kurulum yolu ${result.longest?.length || 0} karakter (sınır ${limit}).`)
  if (result.longest) console.log(`En uzun: ${result.longest.relativePath}`)
  if (result.tooLong.length) {
    console.error(`${result.tooLong.length} dosyanın kurulum yolu ${limit} karakteri aşıyor:`)
    for (const file of result.tooLong.slice(0, 20)) console.error(`  ${file.length}  ${file.relativePath}`)
    process.exit(1)
  }
}

module.exports = { DEFAULT_LIMIT, REFERENCE_INSTALL_ROOT, measurePackagePaths }
