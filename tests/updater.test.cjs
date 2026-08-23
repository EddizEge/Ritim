const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { createUpdateController } = require('../electron/updater.cjs')

class FakeUpdater extends EventEmitter {
  set channel(value) {
    this._channel = value
    this.allowDowngrade = true
  }

  get channel() {
    return this._channel
  }

  async checkForUpdates() {
    this.checkCalls = (this.checkCalls || 0) + 1
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.9.1-beta.2' })
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 42.4, transferred: 424, total: 1000 })
    this.emit('update-downloaded', { version: '0.9.1-beta.2' })
  }

  quitAndInstall(silent, forceRunAfter) {
    this.installArgs = [silent, forceRunAfter]
  }
}

function controller(overrides = {}) {
  const updater = new FakeUpdater()
  const order = []
  const instance = createUpdateController({
    app: { isPackaged: true, getVersion: () => '0.9.1-beta.1' },
    updater,
    logger: { error() {} },
    NotificationClass: { isSupported: () => false },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    beforeInstall: async () => { order.push('beforeInstall') },
    ...overrides,
  })
  return { instance, updater, order }
}

test('Beta güncelleyici kontrol, indirme ve kurma aşamalarını ayrı tutar', async () => {
  const { instance, updater, order } = controller()
  assert.equal(updater.channel, 'beta')
  assert.equal(updater.allowPrerelease, true)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(updater.autoDownload, false)

  await instance.check()
  assert.deepEqual(instance.getStatus(), {
    state: 'available',
    message: 'Ritim 0.9.1-beta.2 indirilmeye hazır.',
    currentVersion: '0.9.1-beta.1',
    availableVersion: '0.9.1-beta.2',
    channel: 'beta',
    lastCheckedAt: '2026-08-23T12:00:00.000Z',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    canDownload: true,
    canInstall: false,
  })

  await instance.download()
  assert.equal(instance.getStatus().state, 'ready')
  assert.equal(instance.getStatus().percent, 100)
  assert.equal(instance.getStatus().totalBytes, 1000)
  assert.equal(instance.getStatus().downloadedBytes, 1000)
  assert.equal(instance.getStatus().canInstall, true)

  await instance.check()
  assert.equal(updater.checkCalls, 1)
  assert.equal(instance.getStatus().state, 'ready')
  assert.equal(instance.getStatus().canInstall, true)

  assert.equal(await instance.install(), true)
  assert.deepEqual(order, ['beforeInstall'])
  assert.deepEqual(updater.installArgs, [false, true])
})

test('RC istemcisi kendi kanalını korur ve Beta sağlayıcı kanalına düşmez', () => {
  const { updater, instance } = controller({ app: { isPackaged: true, getVersion: () => '0.9.1-rc.1' } })
  assert.equal(updater.channel, 'rc')
  assert.equal(updater.allowPrerelease, true)
  assert.equal(instance.getStatus().channel, 'rc')
})

test('RC politikası önce yeni RCyi, RC yoksa kararlı sürümü denetler', async () => {
  class RcUpdater extends EventEmitter {
    calls = []
    set channel(value) { this._channel = value; this.allowDowngrade = true }
    get channel() { return this._channel }
    async checkForUpdates() {
      this.calls.push({ channel: this.channel, allowPrerelease: this.allowPrerelease })
      this.emit('checking-for-update')
      if (this.channel === 'rc') {
        this.emit('update-not-available', { version: '0.9.1-rc.1' })
        return { isUpdateAvailable: false }
      }
      this.emit('update-available', { version: '0.9.1' })
      return { isUpdateAvailable: true }
    }
  }
  const updater = new RcUpdater()
  const instance = createUpdateController({
    app: { isPackaged: true, getVersion: () => '0.9.1-rc.1' },
    updater,
    logger: { error() {} },
    NotificationClass: { isSupported: () => false },
  })

  await instance.check()
  assert.deepEqual(updater.calls, [
    { channel: 'rc', allowPrerelease: true },
    { channel: 'latest', allowPrerelease: false },
  ])
  assert.equal(instance.getStatus().availableVersion, '0.9.1')
  assert.equal(instance.getStatus().channel, 'rc')
  assert.equal(updater.allowDowngrade, false)
})

test('yeni RC bulunduğunda kararlı fallback çalışmaz', async () => {
  class RcUpdater extends EventEmitter {
    calls = []
    set channel(value) { this._channel = value; this.allowDowngrade = true }
    get channel() { return this._channel }
    async checkForUpdates() {
      this.calls.push(this.channel)
      this.emit('checking-for-update')
      this.emit('update-available', { version: '0.9.1-rc.2' })
      return { isUpdateAvailable: true }
    }
  }
  const updater = new RcUpdater()
  const instance = createUpdateController({
    app: { isPackaged: true, getVersion: () => '0.9.1-rc.1' },
    updater,
    logger: { error() {} },
    NotificationClass: { isSupported: () => false },
  })

  await instance.check()
  assert.deepEqual(updater.calls, ['rc'])
  assert.equal(instance.getStatus().availableVersion, '0.9.1-rc.2')
  assert.equal(updater.allowDowngrade, false)
})

test('kurucu hata olayı verirse indirilen paket yeniden denenebilir kalır', async () => {
  const { updater, instance, order } = controller()
  await instance.check()
  await instance.download()
  updater.quitAndInstall = function quitAndInstall() {
    this.emit('error', new Error('installer failed'))
  }

  assert.equal(await instance.install(), false)
  assert.deepEqual(order, ['beforeInstall'])
  assert.equal(instance.getStatus().state, 'ready')
  assert.equal(instance.getStatus().canInstall, true)
  assert.match(instance.getStatus().message, /Ritim açık kaldı/)
})

test('geliştirme paketi ağ kontrolü ve indirme başlatmaz', async () => {
  let checked = false
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => { checked = true }
  const instance = createUpdateController({
    app: { isPackaged: false, getVersion: () => '0.9.1-beta.1' },
    updater,
    logger: { error() {} },
    NotificationClass: { isSupported: () => false },
  })
  assert.equal((await instance.check()).state, 'development')
  assert.equal((await instance.download()).state, 'development')
  assert.equal(checked, false)
})
