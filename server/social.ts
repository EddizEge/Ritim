import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Server } from 'socket.io'
import {
  createPostgresAuthRepository,
  createRedisCompanionTicketStore,
  createSocialAuthService,
  createSocketAuthentication,
  mountSocialAuthRoutes,
  readSocialAuthConfig,
} from './social-auth.js'
import { createSocialInfrastructure } from './social-infrastructure.js'
import {
  createCorsOriginCallback,
  createRateGate,
  createRateLimiter,
  isOriginAllowed,
  logAbuse,
  readSocialSecurityConfig,
  securityHeaders,
} from './social-security.js'
import { createDurableSocialStore } from './social-store.js'

const localRequire = createRequire(import.meta.url)
const { createSocialHub } = localRequire('../electron/social-hub.cjs')
const PORT = Number(process.env.RITIM_SOCIAL_PORT || 8790)
const infrastructure = createSocialInfrastructure()
const authConfig = readSocialAuthConfig()
const securityConfig = readSocialSecurityConfig()
const corsOrigin = createCorsOriginCallback(securityConfig.allowedOrigins)
const socketConnectionGate = createRateGate({
  name: 'socket_connection',
  windowMs: securityConfig.socketWindowMs,
  limit: securityConfig.socketLimit,
  onLimited: logAbuse,
})

const app = express()
if (securityConfig.trustProxy) app.set('trust proxy', securityConfig.trustProxy)
app.disable('x-powered-by')
app.use(securityHeaders)
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(createRateLimiter({
  name: 'http',
  windowMs: securityConfig.requestWindowMs,
  limit: securityConfig.requestLimit,
  skip: (request) => request.path === '/health' || request.path === '/ready',
  onLimited: logAbuse,
}))
app.use(express.json({ limit: '32kb' }))
app.get('/health', (_request, response) => response.json({
  ok: true,
  service: 'ritim-social',
  protocol: 2,
  infrastructure: infrastructure.health(),
  authentication: {
    configured: authConfig.configured,
    required: authConfig.required,
  },
}))
app.get('/ready', async (_request, response) => {
  const infrastructureReady = await infrastructure.probe()
  const authenticationReady = !authConfig.required || Boolean(authService)
  const ready = infrastructureReady && authenticationReady
  response.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'ritim-social',
    infrastructure: infrastructure.health(),
    authentication: {
      configured: authConfig.configured,
      required: authConfig.required,
      ready: authenticationReady,
    },
  })
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: corsOrigin, credentials: true },
  allowRequest: (request, callback) => {
    const allowed = isOriginAllowed(request.headers.origin, securityConfig.allowedOrigins)
    if (!allowed) {
      logAbuse({
        category: 'socket_origin',
        fingerprint: 'origin',
        path: request.url,
        limit: 0,
        windowMs: 0,
      })
    }
    const forwardedAddress = securityConfig.trustProxy
      ? String(request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for'] || '').split(',')[0].trim()
      : ''
    const gate = socketConnectionGate(forwardedAddress || request.socket.remoteAddress)
    callback(null, allowed && gate.allowed)
  },
  maxHttpBufferSize: 100_000,
})
let socialHub: ReturnType<typeof createSocialHub> | undefined
let authService: ReturnType<typeof createSocialAuthService> | undefined

async function shutdown(signal: string) {
  console.log(`[Ritim Social Alpha.4] ${signal} ile kapatiliyor.`)
  socialHub?.close()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await infrastructure.close()
  process.exit(0)
}

async function main() {
  await infrastructure.start()
  const store = infrastructure.pool && infrastructure.redis
    ? createDurableSocialStore(infrastructure.pool, infrastructure.redis)
    : undefined
  if (authConfig.configured && !infrastructure.pool) {
    throw new Error('Ritim kimlik servisi PostgreSQL altyapısı gerektirir.')
  }
  authService = authConfig.configured && infrastructure.pool
    ? createSocialAuthService(
        authConfig,
        createPostgresAuthRepository(infrastructure.pool),
        undefined,
        infrastructure.redis
          ? createRedisCompanionTicketStore(infrastructure.redis)
          : undefined,
      )
    : undefined
  app.use('/auth', createRateLimiter({
    name: 'auth',
    windowMs: securityConfig.authWindowMs,
    limit: securityConfig.authLimit,
    onLimited: logAbuse,
  }))
  mountSocialAuthRoutes(app, authService, authConfig, {
    onDeviceRevoked: (accountId, deviceId) => {
      for (const socket of io.sockets.sockets.values()) {
        const identity = socket.data.socialIdentity
        const socketAccountId = identity?.accountId || socket.data.socialAccountId
        const socketDeviceId = identity?.deviceId || socket.data.socialDeviceId
        if (socketAccountId === accountId && socketDeviceId === deviceId) socket.disconnect(true)
      }
    },
  })
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof Error && /origin reddedildi/i.test(error.message)) {
      response.status(403).json({
        ok: false,
        error: 'origin_forbidden',
        message: 'Bu uygulama kaynağının Ritim Social erişimine izin verilmiyor.',
      })
      return
    }
    next(error)
  })
  io.use(createSocketAuthentication(authService, authConfig))
  infrastructure.setDurableSocialEvents(Boolean(store))
  socialHub = createSocialHub(io, { store, onAbuse: logAbuse })
  io.on('connection', (socket) => socialHub?.attach(socket))
  httpServer.listen(PORT, '0.0.0.0', () => {
    const mode = infrastructure.health().configured ? 'PostgreSQL + Redis' : 'bellek ici gelistirme'
    console.log(`[Ritim Social Alpha.4] http://0.0.0.0:${PORT} • ${mode}`)
  })
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

void main().catch(async (error) => {
  console.error('[Ritim Social Alpha.4] Baslatilamadi:', error instanceof Error ? error.message : error)
  await infrastructure.close()
  process.exit(1)
})
