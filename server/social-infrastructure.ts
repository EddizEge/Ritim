import { Pool } from 'pg'
import { createClient } from 'redis'

type InfrastructureStatus = 'disabled' | 'connecting' | 'ready' | 'error' | 'closed'

export type SocialInfrastructureConfig = {
  required: boolean
  databaseUrl?: string
  databaseHost?: string
  databasePort: number
  databaseName?: string
  databaseUser?: string
  databasePassword?: string
  redisUrl?: string
  redisHost?: string
  redisPort: number
  redisPassword?: string
  databasePoolSize: number
}

export type SocialInfrastructureHealth = {
  configured: boolean
  required: boolean
  postgres: InfrastructureStatus
  redis: InfrastructureStatus
  durableSocialEvents: boolean
}

function parseBoolean(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(String(value || ''))
}

function parsePoolSize(value: string | undefined) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return 10
  return Math.max(2, Math.min(40, parsed))
}

export function readSocialInfrastructureConfig(
  env: NodeJS.ProcessEnv = process.env,
): SocialInfrastructureConfig {
  const databaseUrl = env.RITIM_DATABASE_URL?.trim() || undefined
  const databaseHost = env.RITIM_DB_HOST?.trim() || undefined
  const databaseName = env.RITIM_DB_NAME?.trim() || undefined
  const databaseUser = env.RITIM_DB_USER?.trim() || undefined
  const databasePassword = env.RITIM_DB_PASSWORD?.trim() || undefined
  const databaseParts = [databaseHost, databaseName, databaseUser, databasePassword]
  const hasAnyDatabasePart = databaseParts.some(Boolean)
  const hasAllDatabaseParts = databaseParts.every(Boolean)
  const redisUrl = env.RITIM_REDIS_URL?.trim() || undefined
  const redisHost = env.RITIM_REDIS_HOST?.trim() || undefined
  const redisPassword = env.RITIM_REDIS_PASSWORD?.trim() || undefined
  const hasAnyRedisPart = Boolean(redisHost || redisPassword)
  const hasAllRedisParts = Boolean(redisHost && redisPassword)
  const required = parseBoolean(env.RITIM_INFRA_REQUIRED)
  const databaseConfigured = Boolean(databaseUrl || hasAllDatabaseParts)
  const redisConfigured = Boolean(redisUrl || hasAllRedisParts)

  if (databaseUrl && hasAnyDatabasePart) {
    throw new Error('RITIM_DATABASE_URL ile ayrık PostgreSQL ayarlarından yalnızca biri kullanılmalıdır.')
  }
  if (hasAnyDatabasePart && !hasAllDatabaseParts) {
    throw new Error('RITIM_DB_HOST, NAME, USER ve PASSWORD birlikte ayarlanmalıdır.')
  }
  if (redisUrl && hasAnyRedisPart) {
    throw new Error('RITIM_REDIS_URL ile ayrık Redis ayarlarından yalnızca biri kullanılmalıdır.')
  }
  if (hasAnyRedisPart && !hasAllRedisParts) {
    throw new Error('RITIM_REDIS_HOST ve PASSWORD birlikte ayarlanmalıdır.')
  }
  if (databaseConfigured !== redisConfigured) {
    throw new Error('PostgreSQL ve Redis bağlantıları birlikte ayarlanmalıdır.')
  }
  if (required && (!databaseConfigured || !redisConfigured)) {
    throw new Error('RITIM_INFRA_REQUIRED açıkken PostgreSQL ve Redis bağlantıları zorunludur.')
  }

  return {
    required,
    databaseUrl,
    databaseHost,
    databasePort: Math.max(1, Math.min(65_535, Number.parseInt(env.RITIM_DB_PORT || '5432', 10) || 5432)),
    databaseName,
    databaseUser,
    databasePassword,
    redisUrl,
    redisHost,
    redisPort: Math.max(1, Math.min(65_535, Number.parseInt(env.RITIM_REDIS_PORT || '6379', 10) || 6379)),
    redisPassword,
    databasePoolSize: parsePoolSize(env.RITIM_DB_POOL_SIZE),
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} zaman aşımı`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function createSocialInfrastructure(
  config = readSocialInfrastructureConfig(),
) {
  const databaseConfigured = Boolean(
    config.databaseUrl
    || (config.databaseHost && config.databaseName && config.databaseUser && config.databasePassword),
  )
  const redisConfigured = Boolean(config.redisUrl || (config.redisHost && config.redisPassword))
  const configured = Boolean(databaseConfigured && redisConfigured)
  let postgresStatus: InfrastructureStatus = configured ? 'connecting' : 'disabled'
  let redisStatus: InfrastructureStatus = configured ? 'connecting' : 'disabled'
  let durableSocialEvents = false
  const pool = databaseConfigured
    ? new Pool({
        ...(config.databaseUrl
          ? { connectionString: config.databaseUrl }
          : {
              host: config.databaseHost,
              port: config.databasePort,
              database: config.databaseName,
              user: config.databaseUser,
              password: config.databasePassword,
            }),
        max: config.databasePoolSize,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: 'ritim-social-gateway',
      })
    : undefined
  const redis = redisConfigured
    ? createClient({
        ...(config.redisUrl
          ? { url: config.redisUrl }
          : {
              password: config.redisPassword,
              socket: {
                host: config.redisHost,
                port: config.redisPort,
              },
            }),
        socket: {
          ...(config.redisUrl ? {} : {
            host: config.redisHost,
            port: config.redisPort,
          }),
          connectTimeout: 5_000,
          reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 5_000),
        },
      })
    : undefined

  redis?.on('error', () => {
    redisStatus = 'error'
  })
  pool?.on('error', () => {
    postgresStatus = 'error'
  })

  function health(): SocialInfrastructureHealth {
    return {
      configured,
      required: config.required,
      postgres: postgresStatus,
      redis: redisStatus,
      durableSocialEvents,
    }
  }

  function setDurableSocialEvents(value: boolean) {
    durableSocialEvents = Boolean(value)
  }

  async function probe() {
    if (!configured || !pool || !redis) return !config.required

    const [postgresResult, redisResult] = await Promise.allSettled([
      withTimeout(pool.query('select 1 as ok'), 3_000, 'PostgreSQL'),
      withTimeout(redis.ping(), 3_000, 'Redis'),
    ])
    postgresStatus = postgresResult.status === 'fulfilled' ? 'ready' : 'error'
    redisStatus = redisResult.status === 'fulfilled' ? 'ready' : 'error'
    return postgresStatus === 'ready' && redisStatus === 'ready'
  }

  async function start() {
    if (!configured || !pool || !redis) return
    postgresStatus = 'connecting'
    redisStatus = 'connecting'

    try {
      await withTimeout(redis.connect(), 5_000, 'Redis')
      await withTimeout(pool.query('select 1 as ok'), 5_000, 'PostgreSQL')
      redisStatus = 'ready'
      postgresStatus = 'ready'
    } catch (error) {
      redisStatus = redis?.isReady ? 'ready' : 'error'
      postgresStatus = 'error'
      if (config.required) throw error
    }
  }

  async function close() {
    await Promise.allSettled([
      pool?.end(),
      redis?.isOpen ? redis.quit() : Promise.resolve(),
    ])
    postgresStatus = configured ? 'closed' : 'disabled'
    redisStatus = configured ? 'closed' : 'disabled'
  }

  return {
    config,
    pool,
    redis,
    health,
    setDurableSocialEvents,
    probe,
    start,
    close,
  }
}
