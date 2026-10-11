const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Count every socket the bridge opens. Patched before the bridge is loaded,
// since it takes `io` when required.
const socketClient = require('socket.io-client')
const realIo = socketClient.io
const openedUrls = []
socketClient.io = (url, options) => {
  openedUrls.push(String(url))
  return realIo(url, options)
}

const { bridgeSyncUrl, createDesktopKey, desktopSyncUrl, startSyncServer } = require('../electron/sync-server.cjs')
const { createYouTubeMusicBridge } = require('../electron/ytmusic-bridge.cjs')

function idleWebContents() {
  return {
    isDestroyed: () => false,
    getURL: () => 'about:blank',
    executeJavaScript: async () => null,
    isCurrentlyAudible: () => false,
    focus() {},
    sendInputEvent() {},
    on() {},
    off() {},
  }
}

function captureConsole(context) {
  const lines = []
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level]
    console[level] = (...args) => lines.push(args.map(String).join(' '))
    context.after(() => { console[level] = original })
  }
  return lines
}

test('köprü adresi yalnız kendi Sync sunucumuz dinlerken verilir', async (context) => {
  const desktopKey = createDesktopKey()
  assert.equal(bridgeSyncUrl(null, 'http://127.0.0.1:8787', desktopKey), '')
  assert.equal(bridgeSyncUrl(undefined, 'http://127.0.0.1:8787', desktopKey), '')
  assert.equal(bridgeSyncUrl({ listening: false }, 'http://127.0.0.1:8787', desktopKey), '')
  assert.equal(bridgeSyncUrl({ listening: true }, 'http://127.0.0.1:8787', ''), '')

  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-bridge-offline-'))
  context.after(() => fs.rm(distPath, { recursive: true, force: true }))
  const server = startSyncServer(distPath, 0, { desktopKey })
  context.after(() => new Promise((resolve) => { server.io.close(); server.close(() => resolve()) }))
  // Not listening yet: still no address.
  if (!server.listening) assert.equal(bridgeSyncUrl(server, 'http://127.0.0.1:8787', desktopKey), '')
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  assert.equal(bridgeSyncUrl(server, baseUrl, desktopKey), desktopSyncUrl(baseUrl, desktopKey))
})

test('Sync sunucusu yoksa köprü hiçbir adrese bağlanmaz, komutlar yine çalışır', async (context) => {
  // A foreign process holding the port: it must never see a connection.
  const foreign = net.createServer()
  const connections = []
  foreign.on('connection', (connection) => { connections.push(connection); connection.destroy() })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => foreign.close(() => resolve())))

  const opened = openedUrls.length
  const syncUrl = bridgeSyncUrl(null, `http://127.0.0.1:${foreign.address().port}`, createDesktopKey())
  const bridge = createYouTubeMusicBridge({ webContents: idleWebContents(), room: 'OFFLINE', syncUrl })
  context.after(() => bridge.destroy())
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(openedUrls.length, opened)
  assert.equal(connections.length, 0)
  assert.equal(typeof bridge.command, 'function')
})

test('pairing:error kısa bir uyarıyla loglanır; anahtar ve adres loga düşmez', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-bridge-pairing-'))
  context.after(() => fs.rm(distPath, { recursive: true, force: true }))
  // The server expects a different key, as a foreign or restarted one would.
  const server = startSyncServer(distPath, 0, { desktopKey: createDesktopKey() })
  context.after(() => new Promise((resolve) => { server.io.close(); server.close(() => resolve()) }))
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  const lines = captureConsole(context)

  const wrongKey = createDesktopKey()
  const syncUrl = desktopSyncUrl(`http://127.0.0.1:${server.address().port}`, wrongKey)
  const bridge = createYouTubeMusicBridge({ webContents: idleWebContents(), room: 'PAIRING-ERR', syncUrl })
  context.after(() => bridge.destroy())

  const deadline = Date.now() + 5000
  while (!lines.some((line) => line.includes('kabul etmedi')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const warning = lines.find((line) => line.includes('kabul etmedi'))
  assert.ok(warning, `uyarı bekleniyordu: ${JSON.stringify(lines)}`)
  assert.match(warning, /Ritim PC uygulaması olarak doğrulanamadı/)
  assert.ok(warning.length < 300)
  for (const line of lines) {
    assert.ok(!line.includes(wrongKey), 'anahtar loga düştü')
    assert.ok(!line.includes('desktopKey='), 'anahtarlı adres loga düştü')
  }
})
