import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { acceptsReleaseForChannel, selectMobileRelease } from '../src/mobileUpdatePolicy'

const require = createRequire(import.meta.url)
const windowsPolicy = require('../electron/version-policy.cjs') as {
  acceptsReleaseForChannel: (candidate: string, current: string) => boolean
  selectUpdateVersion: (candidates: string[], current: string) => string
}

// 0.9.0 is left out on purpose: Android treats that one historic build as Beta
// (mobileUpdateChannel), the PC never shipped it as a prerelease.
const VERSIONS = [
  '0.9.1-alpha.1', '0.9.1-alpha.2', '0.9.1-beta.3', '0.9.1-beta.4', '0.9.1-rc.1', '0.9.1-rc.2',
  '0.9.1', '0.9.2-alpha.1', '0.9.2-beta.1', '0.9.2-rc.1', '0.9.2', '1.0.0-beta.1', '1.0.0',
]

test('Android ve Windows aynı kanal kuralını uygular', () => {
  for (const current of VERSIONS) {
    for (const candidate of VERSIONS) {
      assert.equal(
        acceptsReleaseForChannel(candidate, current),
        windowsPolicy.acceptsReleaseForChannel(candidate, current),
        `${current} -> ${candidate}`,
      )
    }
  }
})

test('Android ve Windows aynı sürüm listesinden aynı güncellemeyi seçer; düşürme yok', () => {
  for (const current of VERSIONS) {
    const releases = VERSIONS.map((version) => ({ tag_name: `v${version}`, assets: [] }))
    const mobile = selectMobileRelease(releases, current)?.tag_name?.replace(/^v/, '') || ''
    const selected = windowsPolicy.selectUpdateVersion(VERSIONS.map((version) => `v${version}`), current)
    const windows = selected && selected !== current && VERSIONS.indexOf(selected) > VERSIONS.indexOf(current) ? selected : ''
    assert.equal(mobile, windows, current)
  }
  const expected: Record<string, string> = {
    '0.9.1-beta.3': '1.0.0',
    '0.9.1-rc.2': '1.0.0',
    '1.0.0': '',
  }
  for (const [current, version] of Object.entries(expected)) {
    assert.equal(selectMobileRelease(VERSIONS.map((item) => ({ tag_name: `v${item}` })), current)?.tag_name?.replace(/^v/, '') || '', version)
  }
})

test('Android beta istemcisi beta, RC ve kararlıyı adım adım görür', () => {
  const pick = (current: string, versions: string[]) => selectMobileRelease(versions.map((version) => ({ tag_name: `v${version}` })), current)?.tag_name || ''
  assert.equal(pick('0.9.1-beta.3', ['0.9.1-beta.4', '0.9.1-beta.3']), 'v0.9.1-beta.4')
  assert.equal(pick('0.9.1-beta.3', ['0.9.1-beta.4', '0.9.1-rc.1']), 'v0.9.1-rc.1')
  assert.equal(pick('0.9.1-rc.1', ['0.9.2-beta.1', '0.9.1']), 'v0.9.1')
  assert.equal(pick('0.9.1-rc.1', ['0.9.2-beta.1', '0.9.1-beta.9']), '')
  assert.equal(pick('0.9.1', ['0.9.2-rc.1', '0.9.2-beta.1', '0.9.1-rc.2']), '')
  assert.equal(pick('0.9.1-alpha.1', ['0.9.1-rc.1', '0.9.1-alpha.2']), 'v0.9.1-rc.1')
})
