const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {
  SOCIAL_PAGE_CSP,
  createSocialProtocolHandler,
  isExternalWebUrl,
  isSocialPageUrl,
  resolveSocialAsset,
  socialPageUrl,
  socialSchemePrivileges,
} = require('../electron/social-page.cjs')

const distRoot = path.join(__dirname, 'fixtures-dist-not-used')

test('sosyal sayfa adresi paketli ve geliştirme modunda ayrılır', () => {
  assert.equal(socialPageUrl({ isPackaged: true }), 'ritim-app://social/desktop-social.html')
  assert.equal(socialPageUrl({ isPackaged: false }), 'http://localhost:5173/desktop-social.html')
  assert.equal(socialPageUrl({ isPackaged: false, devServerUrl: 'http://127.0.0.1:5199/' }), 'http://127.0.0.1:5199/desktop-social.html')
  const { scheme, privileges } = socialSchemePrivileges()
  assert.equal(scheme, 'ritim-app')
  assert.equal(privileges.standard, true)
  assert.equal(privileges.secure, true)
  assert.equal(privileges.corsEnabled, true)
  assert.equal(privileges.bypassCSP, undefined)
})

test('görünüm yalnız kendi sayfasında kalır; dış bağlantı yalnız HTTPS', () => {
  const page = 'ritim-app://social/desktop-social.html'
  assert.equal(isSocialPageUrl('ritim-app://social/desktop-social.html?x=1#y', page), true)
  assert.equal(isSocialPageUrl('ritim-app://social/index.html', page), false)
  assert.equal(isSocialPageUrl('ritim-app://evil/desktop-social.html', page), false)
  assert.equal(isSocialPageUrl('https://music.youtube.com/', page), false)
  assert.equal(isSocialPageUrl('bozuk', page), false)
  assert.equal(isSocialPageUrl('http://localhost:5173/desktop-social.html', 'http://localhost:5173/desktop-social.html'), true)
  assert.equal(isSocialPageUrl('http://localhost:5174/desktop-social.html', 'http://localhost:5173/desktop-social.html'), false)
  assert.equal(isExternalWebUrl('https://github.com/EddizEge/Ritim'), true)
  assert.equal(isExternalWebUrl('http://example.com'), false)
  assert.equal(isExternalWebUrl('file:///C:/Windows/system32/calc.exe'), false)
  assert.equal(isExternalWebUrl('https://user:pass@example.com'), false)
})

test('protokol yalnız dist içindeki bilinen dosya türlerini sunar', () => {
  const root = path.resolve(distRoot)
  assert.deepEqual(resolveSocialAsset(distRoot, 'ritim-app://social/desktop-social.html'), {
    filePath: path.join(root, 'desktop-social.html'),
    contentType: 'text/html; charset=utf-8',
  })
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/').filePath, path.join(root, 'desktop-social.html'))
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/assets/app-1.js').contentType, 'text/javascript; charset=utf-8')
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/assets/app.css').contentType, 'text/css; charset=utf-8')
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://other/desktop-social.html'), null)
  assert.equal(resolveSocialAsset(distRoot, 'https://social/desktop-social.html'), null)
  // URL parsing folds dot segments into the root; nothing resolves above dist/.
  for (const attempt of ['ritim-app://social/../package.json', 'ritim-app://social/%2e%2e/%2e%2e/package.json']) {
    const asset = resolveSocialAsset(distRoot, attempt)
    assert.equal(asset === null || asset.filePath.startsWith(`${root}${path.sep}`), true, attempt)
  }
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/..%5c..%5cpackage.json'), null)
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/%2e%2e%2f%2e%2e%2fpackage.json'), null)
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/assets/%E0%A4%A'), null)
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/main.cjs'), null)
  assert.equal(resolveSocialAsset(distRoot, 'ritim-app://social/assets/a%00.js'), null)
})

test('protokol yanıtı CSP ekler, eksik dosyada 404 döner ve yazma isteklerini reddeder', async () => {
  const files = new Map([[path.join(path.resolve(distRoot), 'desktop-social.html'), Buffer.from('<!doctype html>')]])
  const handler = createSocialProtocolHandler({
    distRoot,
    readFile: async (filePath) => {
      if (!files.has(filePath)) throw new Error('ENOENT')
      return files.get(filePath)
    },
  })
  const page = await handler(new Request('ritim-app://social/desktop-social.html'))
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('content-security-policy'), SOCIAL_PAGE_CSP)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await page.text(), '<!doctype html>')
  assert.match(SOCIAL_PAGE_CSP, /script-src 'self'(;|$)/)
  assert.doesNotMatch(SOCIAL_PAGE_CSP, /unsafe-eval/)

  assert.equal((await handler(new Request('ritim-app://social/assets/missing.js'))).status, 404)
  assert.equal((await handler(new Request('ritim-app://social/..%5csecret.json'))).status, 404)
  assert.equal((await handler({ method: 'POST', url: 'ritim-app://social/desktop-social.html' })).status, 405)
})
