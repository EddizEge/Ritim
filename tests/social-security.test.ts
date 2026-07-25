import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCorsOriginCallback,
  createRateGate,
  createRateLimiter,
  isOriginAllowed,
  readSocialSecurityConfig,
} from '../server/social-security.js'

test('origin listesi birebir eşleşir ve originsiz native istemciyi kabul eder', async () => {
  const config = readSocialSecurityConfig({
    RITIM_ALLOWED_ORIGINS: 'https://social.ritim.test, capacitor://localhost',
  })
  assert.equal(isOriginAllowed('https://social.ritim.test', config.allowedOrigins), true)
  assert.equal(isOriginAllowed('HTTPS://SOCIAL.RITIM.TEST/', config.allowedOrigins), true)
  assert.equal(isOriginAllowed('https://evil.test', config.allowedOrigins), false)
  assert.equal(isOriginAllowed(undefined, config.allowedOrigins), true)
  assert.equal(isOriginAllowed('null', config.allowedOrigins), false)

  await assert.rejects(
    () => new Promise((resolve, reject) => {
      createCorsOriginCallback(config.allowedOrigins)('https://evil.test', (error) => {
        if (error) reject(error)
        else resolve(true)
      })
    }),
    /origin reddedildi/,
  )
})

test('socket bağlantı kapısı istemci başına sınır uygular', () => {
  const gate = createRateGate({ name: 'socket', windowMs: 10_000, limit: 2 })
  assert.equal(gate('127.0.0.1').allowed, true)
  assert.equal(gate('127.0.0.1').allowed, true)
  assert.equal(gate('127.0.0.1').allowed, false)
  assert.equal(gate('127.0.0.2').allowed, true)
})

test('proxy ve rate limit değerleri güvenli aralıklarda tutulur', () => {
  const config = readSocialSecurityConfig({
    RITIM_TRUST_PROXY: '99',
    RITIM_RATE_REQUESTS: '1',
    RITIM_AUTH_RATE_REQUESTS: '5000',
  })
  assert.equal(config.trustProxy, 4)
  assert.equal(config.requestLimit, 10)
  assert.equal(config.authLimit, 1000)
})

test('rate limiter sınırdan sonra 429 ve Retry-After döndürür', () => {
  const middleware = createRateLimiter({ name: 'test', windowMs: 10_000, limit: 2 })
  const request = {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    path: '/auth/test',
  } as any
  const calls: Array<{ status?: number; payload?: unknown }> = []
  const response = {
    setHeader() {},
    status(status: number) {
      calls.push({ status })
      return this
    },
    json(payload: unknown) {
      calls[calls.length - 1].payload = payload
      return this
    },
  } as any
  let passed = 0
  const next = () => { passed += 1 }

  middleware(request, response, next)
  middleware(request, response, next)
  middleware(request, response, next)

  assert.equal(passed, 2)
  assert.equal(calls[0].status, 429)
  assert.equal((calls[0].payload as { error: string }).error, 'rate_limited')
})
