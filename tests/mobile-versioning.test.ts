import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsPrereleaseUpdates,
  compareRitimVersions,
  isNewerRitimVersion,
} from '../src/versioning'

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
