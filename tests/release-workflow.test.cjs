const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8')
const certificate = '6a5b01605a4a767da6d21e199d805d8ea230c4da01dcc4335bd18891f36c4458'
const otherCertificate = 'a'.repeat(64)
const awk = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/usr/bin/awk.exe')
  : 'awk'
const awkAvailable = !spawnSync(awk, ['--version'], { encoding: 'utf8' }).error
const script = source.match(/awk '([^']*certificate sha-256 digest:[^']*)'/)?.[1]

function signerDigests(output) {
  const result = spawnSync(awk, [script], { input: output, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return [...new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))].sort().join('\n')
}

test('release verification accepts old, numbered, SDK-range, and scheme-prefixed signer labels', { skip: !awkAvailable }, () => {
  assert.ok(script)
  for (const label of ['Signer:', 'Signer #1', 'Signer', 'Signer (minSdkVersion=24, maxSdkVersion=2147483647)', 'V2 Signer:', 'V3 Signer #1', 'V3.1 Signer (minSdkVersion=33, maxSdkVersion=2147483647)', '  V2 Signer:']) {
    assert.equal(signerDigests(`${label} certificate SHA-256 digest: ${certificate}\n`), certificate)
  }
  assert.equal(signerDigests(`Signer #1 certificate SHA-256 digest: ${certificate.toUpperCase()}\r\n`), certificate)
})

test('release verification ignores source stamps and rejects missing or different signer identities', { skip: !awkAvailable }, () => {
  assert.equal(signerDigests(`Source Stamp Signer certificate SHA-256 digest: ${certificate}\n`), '')
  assert.notEqual(signerDigests(`Signer #1 certificate SHA-256 digest: ${otherCertificate}\n`), certificate)
  const output = [
    `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${certificate}`,
    `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${otherCertificate}`,
  ].join('\n')
  assert.notEqual(signerDigests(output), certificate)
  assert.equal(signerDigests(output.replaceAll(otherCertificate, certificate)), certificate)
})

test('Android recovery keeps the immutable tag and requires existing Windows assets', () => {
  assert.match(source, /workflow_dispatch:/)
  assert.match(source, /ref: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/)
  assert.match(source, /assertTagMatchesVersion/)
  assert.match(source, /Required Windows release asset is missing/)
  assert.match(source, /Ritim-Setup-\$version\.exe\.blockmap/)
  assert.match(source, /No APK signer certificate digest was found/)
  assert.match(source, /test "\$actual_certificate" = "\$expected_certificate"/)
  assert.match(source, /gh release upload "\$RITIM_RELEASE_TAG"/)
})
