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
import { createDurableSocialStore } from './social-store.js'

const localRequire = createRequire(import.meta.url)
const { createSocialHub } = localRequire('../electron/social-hub.cjs')
const PORT = Number(process.env.RITIM_SOCIAL_PORT || 8790)
const infrastructure = createSocialInfrastructure()
const authConfig = readSocialAuthConfig()

const app = express()
app.use(cors())
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
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 100_000,
})
let socialHub: ReturnType<typeof createSocialHub> | undefined
let authService: ReturnType<typeof createSocialAuthService> | undefined

async function shutdown(signal: string) {
  console.log(`[Ritim Social Alpha.2] ${signal} ile kapatiliyor.`)
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
  mountSocialAuthRoutes(app, authService, authConfig)
  io.use(createSocketAuthentication(authService, authConfig))
  infrastructure.setDurableSocialEvents(Boolean(store))
  socialHub = createSocialHub(io, { store })
  io.on('connection', (socket) => socialHub?.attach(socket))
  httpServer.listen(PORT, '0.0.0.0', () => {
    const mode = infrastructure.health().configured ? 'PostgreSQL + Redis' : 'bellek ici gelistirme'
    console.log(`[Ritim Social Alpha.2] http://0.0.0.0:${PORT} • ${mode}`)
  })
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

void main().catch(async (error) => {
  console.error('[Ritim Social Alpha.2] Baslatilamadi:', error instanceof Error ? error.message : error)
  await infrastructure.close()
  process.exit(1)
})
