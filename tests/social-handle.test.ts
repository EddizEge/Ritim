import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { handleFromDisplayName, initialsFromDisplayName } from '../src/social/handle'

const require = createRequire(import.meta.url)
const electronHandle = require('../electron/social-handle.cjs') as { handleFromDisplayName: (name: string) => string }
const root = path.resolve(import.meta.dirname, '..')

const CASES: Array<[string, string]> = [
  ['Işık', '@isik'],
  ['IŞIK DEMİR', '@isikdemir'],
  ['Ediz Ege Mercan', '@edizegemercan'],
  ['Çağrı Öztürk', '@cagriozturk'],
  ['Gülşah Ünal', '@gulsahunal'],
  ['José Ñandú', '@josenandu'],
  ['Ritim PC • EDİZ-PC', '@ritimpcedizpc'],
  ['🎧🎶', ''],
  ['', ''],
  ['a'.repeat(40), `@${'a'.repeat(30)}`],
]

test('handle türetme sunucuyla aynı: tr küçük harf, ı→i, NFKD; boşsa boş kalır', () => {
  for (const [name, expected] of CASES) {
    assert.equal(handleFromDisplayName(name), expected, name)
    assert.equal(electronHandle.handleFromDisplayName(name), expected, `electron: ${name}`)
  }
  assert.equal(handleFromDisplayName(undefined), '')
  assert.equal(initialsFromDisplayName('ışık demir'), 'ID')
  assert.equal(initialsFromDisplayName('  '), 'R')
})

test('sunucu handleFromDisplayName ile aynı kural; istemciler boş handle gönderir, @ritim/@telefon üretmez', () => {
  const hub = fs.readFileSync(path.join(root, 'electron', 'social-hub.cjs'), 'utf8')
  const serverRule = hub.slice(hub.indexOf('function handleFromDisplayName'), hub.indexOf('function sanitizeTrack'))
  for (const step of [".toLocaleLowerCase('tr')", ".replace(/ı/g, 'i')", ".normalize('NFKD')", '.replace(/[^a-z0-9]+/g, \'\')', '.slice(0, 30)']) {
    assert.ok(serverRule.includes(step), `sunucu kuralı: ${step}`)
  }
  const useSocial = fs.readFileSync(path.join(root, 'src', 'hooks', 'useSocial.ts'), 'utf8')
  const auth = fs.readFileSync(path.join(root, 'src', 'social', 'auth.ts'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(useSocial, /handle: handleFromDisplayName\(resolvedName\)/)
  assert.doesNotMatch(useSocial, /'telefon'|'ritimpc'/)
  assert.doesNotMatch(auth, /'@ritim'/)
  assert.match(main, /handle: handleFromDisplayName\(displayName\)/)
  assert.doesNotMatch(main, /\|\| 'ritimpc'/)
})

test('görünürlük seçenekleri her yerde "Herkes / Mesajlaştıklarım / Gizli"', () => {
  const settingsHtml = fs.readFileSync(path.join(root, 'electron', 'settings.html'), 'utf8')
  const mobileSettings = fs.readFileSync(path.join(root, 'src', 'components', 'MobileSettings.tsx'), 'utf8')
  for (const source of [settingsHtml, mobileSettings]) {
    assert.equal((source.match(/>Mesajlaştıklarım</g) || []).length, 2)
    assert.doesNotMatch(source, /Konuştuklarım|Yalnız mesajlaştıklarım/)
  }
  const socialDir = path.join(root, 'src', 'components', 'social')
  for (const file of fs.readdirSync(socialDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(socialDir, file), 'utf8'), /Konuştuklarım|Yalnız mesajlaştıklarım/, file)
  }
})
