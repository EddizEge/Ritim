import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

type SecurityEnvironment = Record<string, string | undefined>

export type SocialSecurityConfig = {
  allowedOrigins: Set<string>
  trustProxy: false | number
  requestWindowMs: number
  requestLimit: number
  authWindowMs: number
  authLimit: number
  socketWindowMs: number
  socketLimit: number
}

type RateLimitOptions = {
  name: string
  windowMs: number
  limit: number
  skip?: (request: Request) => boolean
  onLimited?: (event: AbuseEvent) => void
}

type RateEntry = {
  count: number
  resetAt: number
}

export type RateGate = {
  allowed: boolean
  fingerprint: string
  retryAfter: number
}

export type AbuseEvent = {
  category: string
  fingerprint: string
  method?: string
  path?: string
  limit: number
  windowMs: number
}

const DEFAULT_ORIGINS = [
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
  'http://127.0.0.1:5173',
]

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

export function readSocialSecurityConfig(env: SecurityEnvironment = process.env) {
  const configuredOrigins = String(env.RITIM_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
  const trustProxyValue = boundedInteger(env.RITIM_TRUST_PROXY, 0, 0, 4)
  return {
    allowedOrigins: new Set(configuredOrigins.length ? configuredOrigins : DEFAULT_ORIGINS),
    trustProxy: trustProxyValue > 0 ? trustProxyValue : false,
    requestWindowMs: boundedInteger(env.RITIM_RATE_WINDOW_MS, 60_000, 1_000, 3_600_000),
    requestLimit: boundedInteger(env.RITIM_RATE_REQUESTS, 180, 10, 10_000),
    authWindowMs: boundedInteger(env.RITIM_AUTH_RATE_WINDOW_MS, 900_000, 10_000, 3_600_000),
    authLimit: boundedInteger(env.RITIM_AUTH_RATE_REQUESTS, 30, 3, 1_000),
    socketWindowMs: boundedInteger(env.RITIM_SOCKET_RATE_WINDOW_MS, 60_000, 1_000, 3_600_000),
    socketLimit: boundedInteger(env.RITIM_SOCKET_RATE_CONNECTIONS, 45, 5, 1_000),
  } satisfies SocialSecurityConfig
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: Set<string>) {
  if (!origin) return true
  return allowedOrigins.has(normalizeOrigin(origin))
}

export function createCorsOriginCallback(allowedOrigins: Set<string>) {
  return (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => {
    if (isOriginAllowed(origin, allowedOrigins)) callback(null, true)
    else callback(new Error('Ritim Social origin reddedildi.'))
  }
}

export function securityHeaders(_request: Request, response: Response, next: NextFunction) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  response.setHeader('Cache-Control', 'no-store')
  next()
}

export function clientFingerprint(value: string | undefined) {
  return crypto.createHash('sha256').update(value || 'unknown').digest('hex').slice(0, 16)
}

export function logAbuse(event: AbuseEvent) {
  console.warn('[Ritim Social][Abuse]', JSON.stringify(event))
}

export function createRateLimiter(options: RateLimitOptions) {
  const entries = new Map<string, RateEntry>()
  let nextSweepAt = 0

  return (request: Request, response: Response, next: NextFunction) => {
    if (options.skip?.(request)) return next()
    const now = Date.now()
    if (now >= nextSweepAt) {
      for (const [key, entry] of entries) {
        if (entry.resetAt <= now) entries.delete(key)
      }
      nextSweepAt = now + Math.min(options.windowMs, 60_000)
    }

    const fingerprint = clientFingerprint(request.ip || request.socket.remoteAddress)
    const key = `${options.name}:${fingerprint}`
    const current = entries.get(key)
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + options.windowMs }
      : { ...current, count: current.count + 1 }
    entries.set(key, entry)

    const remaining = Math.max(0, options.limit - entry.count)
    response.setHeader('RateLimit-Limit', String(options.limit))
    response.setHeader('RateLimit-Remaining', String(remaining))
    response.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))
    if (entry.count <= options.limit) return next()

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    response.setHeader('Retry-After', String(retryAfter))
    const event = {
      category: options.name,
      fingerprint,
      method: request.method,
      path: request.path,
      limit: options.limit,
      windowMs: options.windowMs,
    }
    options.onLimited?.(event)
    return response.status(429).json({
      ok: false,
      error: 'rate_limited',
      message: 'Çok fazla istek gönderildi. Lütfen kısa süre sonra tekrar dene.',
      retryAfter,
    })
  }
}

export function createRateGate(options: Omit<RateLimitOptions, 'skip'>) {
  const entries = new Map<string, RateEntry>()
  return (clientAddress: string | undefined): RateGate => {
    const now = Date.now()
    const fingerprint = clientFingerprint(clientAddress)
    const current = entries.get(fingerprint)
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + options.windowMs }
      : { ...current, count: current.count + 1 }
    entries.set(fingerprint, entry)
    const allowed = entry.count <= options.limit
    if (!allowed) {
      options.onLimited?.({
        category: options.name,
        fingerprint,
        limit: options.limit,
        windowMs: options.windowMs,
      })
    }
    return {
      allowed,
      fingerprint,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }
}
