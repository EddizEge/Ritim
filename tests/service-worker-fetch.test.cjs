const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const serviceWorkerSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'sw.js'),
  'utf8',
)

function createFetchHandler({ fetchImpl, cacheMatchImpl }) {
  const listeners = new Map()
  const self = {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    clients: {
      claim: () => Promise.resolve(),
    },
    skipWaiting() {},
  }

  vm.runInNewContext(serviceWorkerSource, {
    Response,
    caches: {
      match: cacheMatchImpl,
      open: () => Promise.resolve({ addAll: () => Promise.resolve() }),
    },
    fetch: fetchImpl,
    self,
  })

  return listeners.get('fetch')
}

function dispatchFetch(handler, method = 'GET') {
  let responsePromise
  handler({
    request: { method, url: 'https://ritim.test/example' },
    respondWith(response) {
      responsePromise = Promise.resolve(response)
    },
  })
  return responsePromise
}

test('servis çalışanı GET isteklerinde ağ yanıtını önbelleğe tercih eder', async () => {
  const networkResponse = new Response('network')
  let cacheCalls = 0
  const handler = createFetchHandler({
    fetchImpl: () => Promise.resolve(networkResponse),
    cacheMatchImpl: () => {
      cacheCalls += 1
      return Promise.resolve(new Response('cached'))
    },
  })

  assert.equal(await dispatchFetch(handler), networkResponse)
  assert.equal(cacheCalls, 0)
})

test('servis çalışanı ağ kesildiğinde mevcut önbellek yanıtını döndürür', async () => {
  const cachedResponse = new Response('cached')
  const handler = createFetchHandler({
    fetchImpl: () => Promise.reject(new Error('offline')),
    cacheMatchImpl: () => Promise.resolve(cachedResponse),
  })

  assert.equal(await dispatchFetch(handler), cachedResponse)
})

test('servis çalışanı ağ ve önbellek yoksa sahte başarı yerine Response.error döndürür', async () => {
  for (const cacheMatchImpl of [
    () => Promise.resolve(undefined),
    () => Promise.reject(new Error('cache unavailable')),
  ]) {
    const handler = createFetchHandler({
      fetchImpl: () => Promise.reject(new Error('offline')),
      cacheMatchImpl,
    })

    const response = await dispatchFetch(handler)
    assert.ok(response instanceof Response)
    assert.equal(response.type, 'error')
    assert.equal(response.status, 0)
  }
})

test('servis çalışanı GET dışındaki istekleri ele geçirmez', () => {
  const handler = createFetchHandler({
    fetchImpl: () => Promise.reject(new Error('should not run')),
    cacheMatchImpl: () => Promise.reject(new Error('should not run')),
  })

  assert.equal(dispatchFetch(handler, 'POST'), undefined)
})
