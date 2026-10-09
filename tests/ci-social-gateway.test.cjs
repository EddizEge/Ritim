const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const script = fs.readFileSync(path.join(root, 'deploy/ci/social-gateway-e2e.sh'), 'utf8')

test('CI sosyal gateway işi yerel PostgreSQL + Redis ile sırsız çalışır', () => {
  const job = ci.slice(ci.indexOf('\n  social-gateway:'), ci.indexOf('\n  android:'))
  assert.match(job, /runs-on: ubuntu-latest/)
  assert.match(job, /actions\/checkout@v7/)
  assert.match(job, /actions\/setup-node@v7[\s\S]*node-version: 24/)
  assert.match(job, /- run: npm ci/)
  assert.match(job, /run: bash deploy\/ci\/social-gateway-e2e\.sh/)
  assert.doesNotMatch(ci, /\$\{\{\s*secrets\./, 'CI sırlara ihtiyaç duymamalı')
  assert.match(ci, /\n {2}web:[\s\S]*- run: npm test[\s\S]*- run: npm run build/)
  assert.match(ci, /\n {2}android:/)
})

test('gateway uçtan uca betiği yalnız geçici loopback servislerine bağlanır', () => {
  assert.match(script, /postgres:17-alpine/)
  assert.match(script, /redis:7-alpine/)
  assert.match(script, /deploy\/pi\/postgres\/init/)
  assert.match(script, /node --import tsx server\/social\.ts/)
  const bindings = script.match(/-p "[^"]+:(5432|6379)"/g) || []
  assert.equal(bindings.length, 2)
  for (const binding of bindings) {
    assert.match(binding, /^-p "127\.0\.0\.1:/, `port yalnız loopback'e bağlanmalı: ${binding}`)
  }
  assert.match(script, /docker run -d --rm --name "\$pg_container"/)
  assert.match(script, /docker run -d --rm --name "\$redis_container"/)
  assert.doesNotMatch(script, /edizegemercan|social\.ritim|https:\/\//, 'üretim adresine istek atılmamalı')
  assert.doesNotMatch(script, /pkill|killall|taskkill/, 'yalnız kendi başlattığı PID kapatılmalı')
  for (const testFile of [
    'social-store-postgres.test.ts',
    'social-gateway-message-requests.test.cjs',
    'social-gateway-persistence.test.cjs',
    'social-gateway-auth.test.cjs',
    'social-gateway-policies.test.mjs',
  ]) {
    assert.ok(script.includes(`tests/${testFile}`), `${testFile} CI'da koşmalı`)
  }
})
