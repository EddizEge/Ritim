import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Server } from 'socket.io'
import { createSocialInfrastructure } from './social-infrastructure.js'

const localRequire = createRequire(import.meta.url)
const { createSocialHub } = localRequire('../electron/social-hub.cjs')
const PORT = Number(process.env.RITIM_SOCIAL_PORT || 8790)
const infrastructure = createSocialInfrastructure()

const app = express()
app.use(cors())
app.use(express.json())
app.get('/health', (_request, response) => response.json({
  ok: true,
  service: 'ritim-social',
  protocol: 2,
  infrastructure: infrastructure.health(),
}))
app.get('/ready', async (_request, response) => {
  const ready = await infrastructure.probe()
  response.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'ritim-social',
    infrastructure: infrastructure.health(),
  })
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 100_000,
})
const socialHub = createSocialHub(io)

io.on('connection', (socket) => socialHub.attach(socket))

async function shutdown(signal: string) {
  console.log(`[Ritim Social Alpha.2] ${signal} ile kapatiliyor.`)
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await infrastructure.close()
  process.exit(0)
}

async function main() {
  await infrastructure.start()
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
