import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'
import {
  createCorsOriginCallback,
  createRateGate,
  createRateLimiter,
  isOriginAllowed,
  readSocialSecurityConfig,
  resolveClientAddress,
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

test('socket bağlantı kapısı süresi dolan istemci girdilerini temizler', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const gate = createRateGate({ name: 'socket', windowMs: 10_000, limit: 2 })
  for (let index = 0; index < 500; index += 1) gate(`10.0.${Math.floor(index / 250)}.${index % 250}`)
  assert.equal(gate.size(), 500)

  context.mock.timers.tick(10_001)
  assert.equal(gate('10.9.9.9').allowed, true)
  assert.equal(gate.size(), 1, 'pencere dolunca eski girdiler silinmeli')

  context.mock.timers.tick(5_000)
  gate('10.9.9.9')
  assert.equal(gate('10.9.9.9').allowed, false, 'temizlik etkin pencereyi sıfırlamamalı')
})

test('istemci adresi proxy güveni yokken X-Forwarded-For başlığını yok sayar', () => {
  assert.equal(resolveClientAddress('203.0.113.9', '198.51.100.1', false), '203.0.113.9')
  assert.equal(resolveClientAddress('203.0.113.9', undefined, 1), '203.0.113.9')
  // Cloudflare appends the real client after anything the client sent.
  assert.equal(resolveClientAddress('127.0.0.1', '6.6.6.6, 198.51.100.7', 1), '198.51.100.7')
  assert.equal(resolveClientAddress('127.0.0.1', '6.6.6.6, 198.51.100.7, 10.0.0.2', 2), '198.51.100.7')
  assert.equal(resolveClientAddress('127.0.0.1', '198.51.100.7', 4), '198.51.100.7')
  assert.equal(resolveClientAddress('127.0.0.1', ['6.6.6.6', '198.51.100.7'], 1), '198.51.100.7')
})

test('socket istemci adresi Express trust proxy ile aynı sonucu verir', async (context) => {
  const headers = [undefined, '6.6.6.6', '6.6.6.6, 198.51.100.7', '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5']
  for (const trustProxy of [false, 1, 2, 4] as const) {
    const app = express()
    if (trustProxy) app.set('trust proxy', trustProxy)
    app.get('/ip', (request, response) => {
      response.json({
        express: request.ip,
        socket: resolveClientAddress(
          request.socket.remoteAddress,
          request.headers['x-forwarded-for'],
          trustProxy,
        ),
      })
    })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const { port } = server.address() as AddressInfo
    for (const forwardedFor of headers) {
      const response = await fetch(`http://127.0.0.1:${port}/ip`, {
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
      })
      const result = await response.json() as { express: string; socket: string }
      assert.equal(result.socket, result.express, `trust=${trustProxy} xff=${forwardedFor}`)
    }
  }
})
