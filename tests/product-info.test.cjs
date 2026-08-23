const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const productInfo = require('../shared/product-info.json')

test('ortak ürün bilgisi doğru geliştirici ve bağımsızlık beyanını taşır', () => {
  assert.equal(productInfo.name, 'Ritim')
  assert.equal(productInfo.developer, 'Ediz Ege Mercan')
  assert.match(productInfo.disclaimerTr, /Google veya YouTube ile bağlantılı/i)
  assert.match(productInfo.disclaimerEn, /not affiliated with/i)
  assert.equal(productInfo.projectLicense, 'Tüm hakları saklıdır / All rights reserved')
})

test('Hakkında bağlantıları yalnız güvenli GitHub adresleridir ve belgeler depoda bulunur', () => {
  for (const [name, value] of Object.entries(productInfo.links)) {
    const url = new URL(value)
    assert.equal(url.protocol, 'https:', `${name} HTTPS olmalı`)
    assert.equal(url.hostname, 'github.com', `${name} GitHub adresi olmalı`)
    assert.match(url.pathname, /^\/EddizEge\/Ritim(?:\/|$)/, `${name} kanonik depoya gitmeli`)
  }
  assert.ok(fs.existsSync(path.join(root, 'docs', 'PRIVACY.md')))
  assert.ok(fs.existsSync(path.join(root, 'docs', 'THIRD_PARTY_NOTICES.md')))
})

test('Windows paketi ortak ürün bilgisini içerir', () => {
  const config = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8')
  assert.match(config, /files:\s*\[[^\]]*'shared\/\*\*\/\*'/s)
})
