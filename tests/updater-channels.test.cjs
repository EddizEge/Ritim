// Runs the real electron-updater NsisUpdater against a local fake GitHub
// (releases.atom, /releases/latest API and per-release channel files). No
// network, nothing is downloaded or installed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { NsisUpdater } = require('electron-updater')
const { HttpExecutor } = require(require.resolve('builder-util-runtime', { paths: [require.resolve('electron-updater')] }))
const { createUpdateController } = require('../electron/updater.cjs')
const { acceptsReleaseForChannel, selectUpdateVersion, updateChannel } = require('../electron/version-policy.cjs')

const OWNER = 'EddizEge'
const REPO = 'Ritim'
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

class LocalHttpExecutor extends HttpExecutor {
  createRequest(options, callback) {
    return http.request(options, callback)
  }
}

// `releases` are in feed (publication) order, newest first, as GitHub lists them.
async function startFakeGitHub(releases) {
  const requests = []
  const versions = releases.map((tag) => tag.replace(/^v/, ''))
  const stable = releases.find((tag) => !tag.includes('-'))
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push(url.pathname)
    if (url.pathname === `/${OWNER}/${REPO}/releases.atom`) {
      response.setHeader('content-type', 'application/atom+xml')
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${releases.map((tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>
    <title>Ritim ${tag.slice(1)}</title>
    <content type="html">${tag} notları</content>
  </entry>`).join('\n')}
</feed>`)
      return
    }
    if (url.pathname === `/api/v3/repos/${OWNER}/${REPO}/releases/latest`) {
      if (!stable) return response.writeHead(404).end()
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ tag_name: stable }))
      return
    }
    const download = new RegExp(`^/${OWNER}/${REPO}/releases/download/(v[^/]+)/([a-z]+)\\.yml$`).exec(url.pathname)
    const version = download?.[1].slice(1)
    // Like .github/workflows/release.yml: each release carries only its own channel file.
    if (download && versions.includes(version) && download[2] === updateChannel(version)) {
      response.setHeader('content-type', 'text/yaml')
      response.end([
        `version: ${version}`,
        'files:',
        `  - url: Ritim-Setup-${version}.exe`,
        '    sha512: c2hhNTEy',
        '    size: 1024',
        `path: Ritim-Setup-${version}.exe`,
        'sha512: c2hhNTEy',
        "releaseDate: '2026-10-11T00:00:00.000Z'",
        '',
      ].join('\n'))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, host: `127.0.0.1:${server.address().port}` }
}

function createRealUpdater(t, currentVersion, host) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ritim-updater-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configPath = path.join(directory, 'app-update.yml')
  // Same shape electron-builder writes into resources/app-update.yml, with the
  // GitHub host pointed at the local fake server.
  fs.writeFileSync(configPath, [
    `owner: ${OWNER}`,
    `repo: ${REPO}`,
    'provider: github',
    `host: ${host}`,
    'protocol: http',
    `channel: ${updateChannel(currentVersion)}`,
    'releaseType: release',
    'updaterCacheDirName: ritim-updater',
    '',
  ].join('\n'))
  const updater = new NsisUpdater(null, {
    version: currentVersion,
    name: 'Ritim',
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: directory,
    baseCachePath: directory,
    whenReady: () => Promise.resolve(),
    quit() {},
    relaunch() {},
    onQuit() {},
  })
  updater.httpExecutor = new LocalHttpExecutor()
  updater.logger = silentLogger
  // Ritim ships only the Windows updater. electron-updater names channel files
  // per platform (beta.yml on Windows, beta-linux.yml on Linux), so pin Windows
  // for CI runners on other systems. This only selects the platform.
  updater._testOnlyOptions = { platform: 'win32' }
  return updater
}

async function checkWithController(t, currentVersion, releases) {
  const github = await startFakeGitHub(releases)
  t.after(() => github.server.close())
  const updater = createRealUpdater(t, currentVersion, github.host)
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => currentVersion },
    updater,
    logger: silentLogger,
    NotificationClass: { isSupported: () => false },
  })
  const status = await controller.check()
  return { status, updater, requests: github.requests }
}

test('Windows kanal politikası Android ile aynı kuralı izler', () => {
  const cases = [
    ['0.9.1-alpha.1', ['0.9.1-alpha.2', '0.9.1-beta.1', '0.9.1-rc.1', '0.9.1'], []],
    ['0.9.1-beta.3', ['0.9.1-beta.4', '0.9.1-rc.1', '0.9.1'], ['0.9.1-alpha.9']],
    ['0.9.1-rc.1', ['0.9.1-rc.2', '0.9.1'], ['0.9.2-alpha.1', '0.9.2-beta.1']],
    ['0.9.1', ['0.9.2'], ['0.9.2-alpha.1', '0.9.2-beta.1', '0.9.2-rc.1']],
  ]
  for (const [current, accepted, rejected] of cases) {
    for (const candidate of accepted) assert.equal(acceptsReleaseForChannel(candidate, current), true, `${current} -> ${candidate}`)
    for (const candidate of rejected) assert.equal(acceptsReleaseForChannel(candidate, current), false, `${current} -> ${candidate}`)
  }
  assert.equal(selectUpdateVersion(['v0.9.1-beta.4', 'v0.9.1-rc.1', 'v0.9.0', 'bozuk'], '0.9.1-beta.3'), '0.9.1-rc.1')
  assert.equal(selectUpdateVersion(['v0.9.2-beta.1', 'v0.9.1-rc.2'], '0.9.1'), '')
})

test('beta.3 istemcisi beta.4 yayınını görür', async (t) => {
  const { status, requests } = await checkWithController(t, '0.9.1-beta.3', ['v0.9.1-beta.4', 'v0.9.1-beta.3'])
  assert.equal(status.state, 'available')
  assert.equal(status.availableVersion, '0.9.1-beta.4')
  assert.ok(requests.includes(`/${OWNER}/${REPO}/releases/download/v0.9.1-beta.4/beta.yml`))
})

test('beta istemcisi RC yayınını görür; akıştaki tarih sırası seçimi değiştirmez', async (t) => {
  const { status, updater } = await checkWithController(t, '0.9.1-beta.3', ['v0.9.1-beta.4', 'v0.9.1-rc.1', 'v0.9.1-beta.3'])
  assert.equal(status.state, 'available')
  assert.equal(status.availableVersion, '0.9.1-rc.1')
  const [file] = updater.updateInfoAndProvider.provider.resolveFiles(updater.updateInfoAndProvider.info)
  assert.equal(file.url.pathname, `/${OWNER}/${REPO}/releases/download/v0.9.1-rc.1/Ritim-Setup-0.9.1-rc.1.exe`)
})

test('beta istemcisi kararlı sürümü latest.yml üzerinden görür', async (t) => {
  const { status, requests } = await checkWithController(t, '0.9.1-beta.3', ['v0.9.1', 'v0.9.1-rc.1', 'v0.9.1-beta.4'])
  assert.equal(status.availableVersion, '0.9.1')
  assert.ok(requests.includes(`/${OWNER}/${REPO}/releases/download/v0.9.1/latest.yml`))
  assert.ok(!requests.includes(`/${OWNER}/${REPO}/releases/download/v0.9.1/beta.yml`))
})

test('alpha istemcisi RC ve kararlı dahil en yüksek sürümü alır', async (t) => {
  const { status } = await checkWithController(t, '0.9.1-alpha.2', ['v0.9.1-rc.1', 'v0.9.1-beta.1', 'v0.9.1-alpha.3'])
  assert.equal(status.availableVersion, '0.9.1-rc.1')
})

test('RC istemcisi yeni RCyi ve kararlıyı görür, betayı görmez', async (t) => {
  const nextRc = await checkWithController(t, '0.9.1-rc.1', ['v0.9.2-beta.1', 'v0.9.1-rc.2', 'v0.9.1-rc.1'])
  assert.equal(nextRc.status.availableVersion, '0.9.1-rc.2')
  const stable = await checkWithController(t, '0.9.1-rc.1', ['v0.9.2-beta.1', 'v0.9.1', 'v0.9.1-rc.1'])
  assert.equal(stable.status.availableVersion, '0.9.1')
  const onlyBeta = await checkWithController(t, '0.9.1-rc.1', ['v0.9.2-beta.1', 'v0.9.1-rc.1'])
  assert.equal(onlyBeta.status.state, 'current')
})

test('kararlı istemci RC ve beta görmez, yalnız /releases/latest yolunu kullanır', async (t) => {
  const { status, requests } = await checkWithController(t, '0.9.1', ['v0.9.2-rc.1', 'v0.9.2-beta.1', 'v0.9.1'])
  assert.equal(status.state, 'current')
  assert.deepEqual(requests.filter((request) => request.includes('/download/')), [`/${OWNER}/${REPO}/releases/download/v0.9.1/latest.yml`])
  const newer = await checkWithController(t, '0.9.1', ['v0.9.3-rc.1', 'v0.9.2', 'v0.9.1'])
  assert.equal(newer.status.availableVersion, '0.9.2')
})

test('hiçbir kanal sürüm düşürmez', async (t) => {
  const beta = await checkWithController(t, '0.9.1-beta.4', ['v0.9.1-beta.3', 'v0.9.0'])
  assert.equal(beta.status.state, 'current')
  const rc = await checkWithController(t, '0.9.1-rc.2', ['v0.9.1-rc.1', 'v0.9.1-beta.9'])
  assert.equal(rc.status.state, 'current')
  const stable = await checkWithController(t, '0.9.2', ['v0.9.3-beta.1', 'v0.9.1'])
  assert.equal(stable.status.state, 'current')
})

// Already installed 0.9.1-beta.3 runs the previous updater code: the stock
// GitHubProvider with channel "beta". This pins down how it reaches beta.4 and
// stable without the new provider.
async function legacyBeta3Check(t, releases) {
  const github = await startFakeGitHub(releases)
  t.after(() => github.server.close())
  const updater = createRealUpdater(t, '0.9.1-beta.3', github.host)
  updater.channel = 'beta'
  updater.allowPrerelease = true
  updater.allowDowngrade = false
  updater.autoDownload = false
  const result = await updater.checkForUpdates()
  return { result, requests: github.requests }
}

test('eski beta.3 güncelleyicisi beta.4 yayınını görür, RCyi atlar', async (t) => {
  const { result } = await legacyBeta3Check(t, ['v0.9.1-rc.1', 'v0.9.1-beta.4', 'v0.9.1-beta.3'])
  assert.equal(result.isUpdateAvailable, true)
  assert.equal(result.updateInfo.version, '0.9.1-beta.4')
})

test('eski beta.3 güncelleyicisi kararlı yayında beta.yml bulamayınca latest.yml ile devam eder', async (t) => {
  const { result, requests } = await legacyBeta3Check(t, ['v0.9.1', 'v0.9.1-rc.1', 'v0.9.1-beta.4'])
  assert.equal(result.isUpdateAvailable, true)
  assert.equal(result.updateInfo.version, '0.9.1')
  assert.ok(requests.includes(`/${OWNER}/${REPO}/releases/download/v0.9.1/beta.yml`))
  assert.ok(requests.includes(`/${OWNER}/${REPO}/releases/download/v0.9.1/latest.yml`))
})
