const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const repoRoot = path.join(__dirname, '..')
const indexListing = spawnSync('git', ['ls-files', '-s', 'deploy/pi/backup'], { cwd: repoRoot, encoding: 'utf8' })
const inGitCheckout = !indexListing.error && indexListing.status === 0 && indexListing.stdout.trim() !== ''

// systemd runs these scripts directly (ExecStart/ExecStartPost). The Pi source
// is deployed from a `git archive` tarball, so the executable bit must live in
// git: without it every scheduled backup failed with 203/EXEC from Aug 2026.
test('Pi yedek betikleri git içinde çalıştırılabilir kayıtlıdır', { skip: !inGitCheckout }, () => {
  const entries = indexListing.stdout.trim().split(/\r?\n/)
  assert.ok(entries.length >= 2)
  for (const entry of entries) {
    assert.match(entry, /^100755 /, `çalıştırılabilir olmalı: ${entry}`)
  }
})

test('systemd birimleri yalnız depodaki yedek betiklerini çağırır', () => {
  const unitDirectory = path.join(repoRoot, 'deploy', 'pi', 'systemd')
  const scripts = fs.readdirSync(unitDirectory)
    .filter((name) => name.endsWith('.service'))
    .flatMap((name) => fs.readFileSync(path.join(unitDirectory, name), 'utf8').split(/\r?\n/))
    .filter((line) => /^ExecStart(Post)?=/.test(line))
    .map((line) => line.replace(/^ExecStart(Post)?=/, '').split(/\s+/)[0])
  assert.ok(scripts.length >= 3)
  for (const script of scripts) {
    assert.match(script, /^\/DATA\/AppData\/ritim-alpha2\/source\/deploy\/pi\/backup\/ritim-(backup|restore-smoke)\.sh$/)
    assert.ok(fs.existsSync(path.join(repoRoot, 'deploy', 'pi', 'backup', path.basename(script))), script)
  }
})
