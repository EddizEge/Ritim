const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('gateway günlük etiketi sürüm adı taşımaz', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'social.ts'), 'utf8')
  const labels = source.match(/\[Ritim Social[^\]]*\]/g) || []
  assert.ok(labels.length >= 3, 'açılış, kapanış ve hata satırları etiketli olmalı')
  assert.deepEqual([...new Set(labels)], ['[Ritim Social]'])
  assert.doesNotMatch(source, /Ritim Social (Alpha|Beta|RC)/i)
})
