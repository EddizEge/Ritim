import crypto from 'node:crypto'
import type { Express, NextFunction, Request, Response } from 'express'
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'
import type { Pool, PoolClient } from 'pg'

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GOOGLE_SCOPES = ['openid', 'profile', 'email']
const REFRESH_TOKEN_PREFIX = 'ritim_r1_'
const COMPANION_TICKET_PREFIX = 'ritim_ct1_'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLIENT_ID_PATTERN = /^[\w.-]+\.apps\.googleusercontent\.com$/
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/
const DEVICE_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,200}$/

export type DeviceRole = 'desktop' | 'companion'

export type SocialAuthConfig = {
  configured: boolean
  required: boolean
  jwtSecret?: string
  issuer: string
  audience: string
  googleClientIds: string[]
  googleClientSecret?: string
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
}

export type GoogleIdentityClaims = {
  issuer: string
  subject: string
  audience: string
  displayName: string
  avatarUrl?: string
}

export type AuthIdentity = {
  accountId: string
  deviceId: string
  sessionId: string
  deviceRole: DeviceRole
  displayName: string
  handle: string
  initials: string
  avatarUrl?: string
  avatarTone: number
}

type LoginInput = GoogleIdentityClaims & {
  deviceKey: string
  deviceRole: DeviceRole
  deviceName: string
}

type RotationResult =
  | { status: 'ok'; identity: AuthIdentity }
  | { status: 'invalid' }
  | { status: 'reused' }

export type SocialAuthRepository = {
  createIdentitySession: (
    input: LoginInput,
    refreshTokenHash: Buffer,
    expiresAt: Date,
  ) => Promise<AuthIdentity>
  createCompanionSession: (
    accountId: string,
    input: { deviceKey: string; deviceName: string },
    refreshTokenHash: Buffer,
    expiresAt: Date,
  ) => Promise<AuthIdentity>
  rotateRefreshSession: (
    refreshTokenHash: Buffer,
    nextRefreshTokenHash: Buffer,
    nextExpiresAt: Date,
  ) => Promise<RotationResult>
  resolveAccessSession: (
    accountId: string,
    deviceId: string,
    sessionId: string,
  ) => Promise<AuthIdentity | null>
  revokeSessionFamily: (accountId: string, sessionId: string) => Promise<boolean>
  revokeDevice: (accountId: string, deviceId: string) => Promise<boolean>
}

export type CompanionTicketStore = {
  issue: (accountId: string) => Promise<{ ticket: string; expiresIn: number }>
  consume: (ticket: string) => Promise<string | null>
}

export type GoogleIdentityProvider = {
  exchangeAuthorizationCode: (input: {
    code: string
    codeVerifier: string
    clientId: string
    redirectUri: string
  }) => Promise<string>
  verifyIdToken: (idToken: string, clientId: string) => Promise<GoogleIdentityClaims>
}

class AuthError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
  }
}

function parseBoolean(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(String(value || ''))
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

function cleanText(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength)
}

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest()
}

function profileInitials(displayName: string) {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('tr'))
    .join('')
    .slice(0, 3) || 'R'
}

function identityHandle(displayName: string, issuer: string, subject: string) {
  const prefix = displayName
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 18) || 'ritim'
  const suffix = sha256(`${issuer}\0${subject}`).toString('hex').slice(0, 12)
  return `@${prefix}_${suffix}`
}

function refreshToken() {
  return `${REFRESH_TOKEN_PREFIX}${crypto.randomBytes(48).toString('base64url')}`
}

function refreshTokenHash(value: string) {
  if (!new RegExp(`^${REFRESH_TOKEN_PREFIX}[A-Za-z0-9_-]{64}$`).test(value)) {
    throw new AuthError(401, 'invalid_refresh_token', 'Yenileme tokenı geçersiz.')
  }
  return sha256(value)
}

function safeRedirectUri(value: string) {
  if (value.length > 1000) return false
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("set local statement_timeout = '5s'")
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

function rowIdentity(row: Record<string, unknown>): AuthIdentity {
  return {
    accountId: String(row.account_public_id),
    deviceId: String(row.device_public_id),
    sessionId: String(row.session_public_id),
    deviceRole: row.device_type === 'companion' ? 'companion' : 'desktop',
    displayName: String(row.display_name),
    handle: String(row.handle),
    initials: String(row.initials),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
    avatarTone: Number(row.avatar_tone) || 0,
  }
}

export function readSocialAuthConfig(env: NodeJS.ProcessEnv = process.env): SocialAuthConfig {
  const required = parseBoolean(env.RITIM_AUTH_REQUIRED)
  const jwtSecret = env.RITIM_AUTH_JWT_SECRET?.trim() || undefined
  const googleClientIds = [...new Set(
    String(env.RITIM_GOOGLE_CLIENT_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )]
  const hasAnyConfiguration = Boolean(jwtSecret || googleClientIds.length || env.RITIM_GOOGLE_CLIENT_SECRET)

  if (googleClientIds.some((clientId) => !CLIENT_ID_PATTERN.test(clientId))) {
    throw new Error('RITIM_GOOGLE_CLIENT_IDS geçerli Google OAuth istemci kimlikleri içermelidir.')
  }
  if (jwtSecret && Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('RITIM_AUTH_JWT_SECRET en az 32 bayt olmalıdır.')
  }
  if (hasAnyConfiguration && (!jwtSecret || !googleClientIds.length)) {
    throw new Error('Ritim kimliği için JWT secret ve en az bir Google client ID birlikte ayarlanmalıdır.')
  }
  if (required && (!jwtSecret || !googleClientIds.length)) {
    throw new Error('RITIM_AUTH_REQUIRED açıkken kimlik yapılandırması zorunludur.')
  }

  return {
    configured: Boolean(jwtSecret && googleClientIds.length),
    required,
    jwtSecret,
    issuer: cleanText(env.RITIM_AUTH_ISSUER, 200) || 'ritim-social',
    audience: cleanText(env.RITIM_AUTH_AUDIENCE, 200) || 'ritim-social-clients',
    googleClientIds,
    googleClientSecret: env.RITIM_GOOGLE_CLIENT_SECRET?.trim() || undefined,
    accessTokenTtlSeconds: boundedInteger(env.RITIM_ACCESS_TOKEN_TTL_SECONDS, 900, 300, 3600),
    refreshTokenTtlSeconds: boundedInteger(env.RITIM_REFRESH_TOKEN_TTL_SECONDS, 2_592_000, 86_400, 7_776_000),
  }
}

export function createPostgresAuthRepository(pool: Pool): SocialAuthRepository {
  async function createIdentitySession(
    input: LoginInput,
    tokenHash: Buffer,
    expiresAt: Date,
  ) {
    return inTransaction(pool, async (client) => {
      const handle = identityHandle(input.displayName, input.issuer, input.subject)
      const userResult = await client.query(
        `insert into ritim.users (
          oidc_issuer, oidc_subject, display_name, handle, initials, avatar_url
        ) values ($1, $2, $3, $4, $5, $6)
        on conflict (oidc_issuer, oidc_subject) do update set
          display_name = excluded.display_name,
          initials = excluded.initials,
          avatar_url = excluded.avatar_url
        returning id, public_id as account_public_id, display_name, handle, initials,
          avatar_url, avatar_tone`,
        [
          input.issuer,
          input.subject,
          input.displayName,
          handle,
          profileInitials(input.displayName),
          input.avatarUrl || null,
        ],
      )
      const user = userResult.rows[0]
      const deviceResult = await client.query(
        `insert into ritim.devices (
          user_id, device_type, display_name, device_key_hash, last_seen_at
        ) values ($1, $2, $3, $4, now())
        on conflict (device_key_hash) do update set
          device_type = excluded.device_type,
          display_name = excluded.display_name,
          last_seen_at = now(),
          revoked_at = null
        where ritim.devices.user_id = excluded.user_id
        returning id, public_id as device_public_id, device_type`,
        [user.id, input.deviceRole, input.deviceName, sha256(input.deviceKey)],
      )
      if (!deviceResult.rowCount) {
        throw new AuthError(409, 'device_identity_conflict', 'Bu cihaz anahtarı başka bir hesaba bağlı.')
      }
      const device = deviceResult.rows[0]
      const sessionResult = await client.query(
        `insert into ritim.sessions (
          user_id, device_id, refresh_token_hash, expires_at
        ) values ($1, $2, $3, $4)
        returning public_id as session_public_id`,
        [user.id, device.id, tokenHash, expiresAt],
      )
      return rowIdentity({ ...user, ...device, ...sessionResult.rows[0] })
    })
  }

  async function createCompanionSession(
    accountId: string,
    input: { deviceKey: string; deviceName: string },
    tokenHash: Buffer,
    expiresAt: Date,
  ) {
    if (!UUID_PATTERN.test(accountId)) {
      throw new AuthError(401, 'invalid_companion_ticket', 'Telefon eşleme bileti geçersiz.')
    }
    return inTransaction(pool, async (client) => {
      const userResult = await client.query(
        `select id, public_id as account_public_id, display_name, handle, initials,
          avatar_url, avatar_tone
         from ritim.users
         where public_id = $1
         for update`,
        [accountId],
      )
      const user = userResult.rows[0]
      if (!user) throw new AuthError(401, 'invalid_companion_ticket', 'Telefon hesabı bulunamadı.')
      const deviceResult = await client.query(
        `insert into ritim.devices (
          user_id, device_type, display_name, device_key_hash, last_seen_at
        ) values ($1, 'companion', $2, $3, now())
        on conflict (device_key_hash) do update set
          device_type = 'companion',
          display_name = excluded.display_name,
          last_seen_at = now(),
          revoked_at = null
        where ritim.devices.user_id = excluded.user_id
        returning id, public_id as device_public_id, device_type`,
        [user.id, input.deviceName, sha256(input.deviceKey)],
      )
      if (!deviceResult.rowCount) {
        throw new AuthError(409, 'device_identity_conflict', 'Bu telefon anahtarı başka bir hesaba bağlı.')
      }
      const device = deviceResult.rows[0]
      const sessionResult = await client.query(
        `insert into ritim.sessions (
          user_id, device_id, refresh_token_hash, expires_at
        ) values ($1, $2, $3, $4)
        returning public_id as session_public_id`,
        [user.id, device.id, tokenHash, expiresAt],
      )
      return rowIdentity({ ...user, ...device, ...sessionResult.rows[0] })
    })
  }

  async function rotateRefreshSession(
    tokenHash: Buffer,
    nextTokenHash: Buffer,
    nextExpiresAt: Date,
  ): Promise<RotationResult> {
    return inTransaction(pool, async (client) => {
      const currentResult = await client.query(
        `select
          session.id,
          session.public_id as session_public_id,
          session.user_id,
          session.device_id,
          session.token_family_id,
          session.expires_at,
          session.rotated_at,
          session.revoked_at,
          account.public_id as account_public_id,
          account.display_name,
          account.handle,
          account.initials,
          account.avatar_url,
          account.avatar_tone,
          device.public_id as device_public_id,
          device.device_type,
          device.revoked_at as device_revoked_at
        from ritim.sessions session
        join ritim.users account on account.id = session.user_id
        join ritim.devices device on device.id = session.device_id
        where session.refresh_token_hash = $1
        for update of session`,
        [tokenHash],
      )
      const current = currentResult.rows[0]
      if (!current) return { status: 'invalid' }

      if (current.rotated_at) {
        await client.query(
          `update ritim.sessions
           set revoked_at = coalesce(revoked_at, now()),
               reuse_detected_at = case when id = $2 then now() else reuse_detected_at end
           where token_family_id = $1`,
          [current.token_family_id, current.id],
        )
        return { status: 'reused' }
      }

      if (
        current.revoked_at
        || current.device_revoked_at
        || new Date(current.expires_at).getTime() <= Date.now()
      ) {
        await client.query(
          'update ritim.sessions set revoked_at = coalesce(revoked_at, now()) where id = $1',
          [current.id],
        )
        return { status: 'invalid' }
      }

      await client.query(
        'update ritim.sessions set rotated_at = now(), last_used_at = now() where id = $1',
        [current.id],
      )
      const nextResult = await client.query(
        `insert into ritim.sessions (
          user_id, device_id, refresh_token_hash, token_family_id,
          parent_session_id, expires_at
        ) values ($1, $2, $3, $4, $5, $6)
        returning public_id as session_public_id`,
        [
          current.user_id,
          current.device_id,
          nextTokenHash,
          current.token_family_id,
          current.id,
          nextExpiresAt,
        ],
      )
      return {
        status: 'ok',
        identity: rowIdentity({ ...current, ...nextResult.rows[0] }),
      }
    })
  }

  async function resolveAccessSession(accountId: string, deviceId: string, sessionId: string) {
    if (![accountId, deviceId, sessionId].every((value) => UUID_PATTERN.test(value))) return null
    const result = await pool.query(
      `select
        account.public_id as account_public_id,
        account.display_name,
        account.handle,
        account.initials,
        account.avatar_url,
        account.avatar_tone,
        device.public_id as device_public_id,
        device.device_type,
        session.public_id as session_public_id
      from ritim.sessions session
      join ritim.users account on account.id = session.user_id
      join ritim.devices device on device.id = session.device_id
      where account.public_id = $1
        and device.public_id = $2
        and session.public_id = $3
        and session.revoked_at is null
        and session.rotated_at is null
        and session.expires_at > now()
        and device.revoked_at is null`,
      [accountId, deviceId, sessionId],
    )
    return result.rows[0] ? rowIdentity(result.rows[0]) : null
  }

  async function revokeSessionFamily(accountId: string, sessionId: string) {
    const result = await pool.query(
      `with selected_family as (
         select session.token_family_id
         from ritim.sessions session
         join ritim.users account on account.id = session.user_id
         where account.public_id = $1 and session.public_id = $2
       )
       update ritim.sessions
       set revoked_at = coalesce(revoked_at, now())
       where token_family_id in (select token_family_id from selected_family)`,
      [accountId, sessionId],
    )
    return Boolean(result.rowCount)
  }

  async function revokeDevice(accountId: string, deviceId: string) {
    return inTransaction(pool, async (client) => {
      const deviceResult = await client.query<{ id: string }>(
        `update ritim.devices device
         set revoked_at = now()
         from ritim.users account
         where device.user_id = account.id
           and account.public_id = $1
           and device.public_id = $2
           and device.revoked_at is null
         returning device.id`,
        [accountId, deviceId],
      )
      if (!deviceResult.rowCount) return false
      await client.query(
        `update ritim.sessions
         set revoked_at = coalesce(revoked_at, now())
         where device_id = $1 and revoked_at is null`,
        [deviceResult.rows[0].id],
      )
      return true
    })
  }

  return {
    createIdentitySession,
    createCompanionSession,
    rotateRefreshSession,
    resolveAccessSession,
    revokeSessionFamily,
    revokeDevice,
  }
}

export function createRedisCompanionTicketStore(redis: {
  set: (key: string, value: string, options: { EX: number }) => Promise<unknown>
  getDel: (key: string) => Promise<string | null>
}): CompanionTicketStore {
  const expiresIn = 120

  async function issue(accountId: string) {
    const ticket = `${COMPANION_TICKET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
    await redis.set(
      `ritim:companion-ticket:${sha256(ticket).toString('hex')}`,
      accountId,
      { EX: expiresIn },
    )
    return { ticket, expiresIn }
  }

  async function consume(ticket: string) {
    if (!new RegExp(`^${COMPANION_TICKET_PREFIX}[A-Za-z0-9_-]{43}$`).test(ticket)) return null
    return redis.getDel(`ritim:companion-ticket:${sha256(ticket).toString('hex')}`)
  }

  return { issue, consume }
}

export function createGoogleIdentityProvider(config: SocialAuthConfig): GoogleIdentityProvider {
  async function verifyIdToken(idToken: string, clientId: string): Promise<GoogleIdentityClaims> {
    if (!config.googleClientIds.includes(clientId)) {
      throw new AuthError(400, 'invalid_client', 'Google istemci kimliği izinli değil.')
    }
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    })
    const subject = cleanText(payload.sub, 255)
    if (!subject) throw new AuthError(401, 'invalid_google_identity', 'Google kullanıcı kimliği bulunamadı.')
    return {
      issuer: payload.iss === 'accounts.google.com' ? GOOGLE_ISSUERS[0] : String(payload.iss),
      subject,
      audience: clientId,
      displayName: cleanText(payload.name, 60) || 'Ritim kullanıcısı',
      avatarUrl: cleanText(payload.picture, 1000) || undefined,
    }
  }

  async function exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
    clientId: string
    redirectUri: string
  }) {
    if (!config.googleClientIds.includes(input.clientId)) {
      throw new AuthError(400, 'invalid_client', 'Google istemci kimliği izinli değil.')
    }
    if (!PKCE_VERIFIER_PATTERN.test(input.codeVerifier)) {
      throw new AuthError(400, 'invalid_pkce_verifier', 'PKCE code verifier geçersiz.')
    }
    if (!safeRedirectUri(input.redirectUri)) {
      throw new AuthError(400, 'invalid_redirect_uri', 'OAuth yönlendirme adresi geçersiz.')
    }
    const body = new URLSearchParams({
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    })
    if (config.googleClientSecret) body.set('client_secret', config.googleClientSecret)
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok || typeof payload.id_token !== 'string') {
      throw new AuthError(401, 'google_exchange_failed', 'Google yetkilendirme kodu doğrulanamadı.')
    }
    return payload.id_token
  }

  return { exchangeAuthorizationCode, verifyIdToken }
}

export function createSocialAuthService(
  config: SocialAuthConfig,
  repository: SocialAuthRepository,
  googleProvider = createGoogleIdentityProvider(config),
  companionTickets?: CompanionTicketStore,
) {
  if (!config.configured || !config.jwtSecret) {
    throw new Error('Ritim kimlik servisi yapılandırılmamış.')
  }
  const signingKey = new TextEncoder().encode(config.jwtSecret)

  async function accessToken(identity: AuthIdentity) {
    return new SignJWT({
      device_id: identity.deviceId,
      session_id: identity.sessionId,
      device_role: identity.deviceRole,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject(identity.accountId)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
      .sign(signingKey)
  }

  async function tokenPair(identity: AuthIdentity, rawRefreshToken: string) {
    return {
      tokenType: 'Bearer',
      accessToken: await accessToken(identity),
      expiresIn: config.accessTokenTtlSeconds,
      refreshToken: rawRefreshToken,
      refreshExpiresIn: config.refreshTokenTtlSeconds,
      user: {
        id: identity.accountId,
        displayName: identity.displayName,
        handle: identity.handle,
        initials: identity.initials,
        avatarUrl: identity.avatarUrl,
        avatarTone: identity.avatarTone,
      },
      device: {
        id: identity.deviceId,
        role: identity.deviceRole,
      },
    }
  }

  function validateLoginInput(input: Record<string, unknown>) {
    const clientId = cleanText(input.clientId, 255)
    const deviceKey = cleanText(input.deviceKey, 200)
    const deviceName = cleanText(input.deviceName, 80)
    const deviceRole: DeviceRole = input.deviceRole === 'companion' ? 'companion' : 'desktop'
    if (!config.googleClientIds.includes(clientId)) {
      throw new AuthError(400, 'invalid_client', 'Google istemci kimliği izinli değil.')
    }
    if (!DEVICE_KEY_PATTERN.test(deviceKey)) {
      throw new AuthError(400, 'invalid_device_key', 'Cihaz anahtarı geçersiz.')
    }
    if (!deviceName) throw new AuthError(400, 'invalid_device_name', 'Cihaz adı gerekli.')
    return { clientId, deviceKey, deviceName, deviceRole }
  }

  async function finishGoogleLogin(
    idToken: string,
    input: ReturnType<typeof validateLoginInput>,
  ) {
    const googleIdentity = await googleProvider.verifyIdToken(idToken, input.clientId)
    const rawRefreshToken = refreshToken()
    const identity = await repository.createIdentitySession(
      {
        ...googleIdentity,
        deviceKey: input.deviceKey,
        deviceName: input.deviceName,
        deviceRole: input.deviceRole,
      },
      refreshTokenHash(rawRefreshToken),
      new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    )
    return tokenPair(identity, rawRefreshToken)
  }

  async function loginWithGoogleIdToken(input: Record<string, unknown>) {
    const validated = validateLoginInput(input)
    const idToken = cleanText(input.idToken, 10_000)
    if (!idToken) throw new AuthError(400, 'missing_id_token', 'Google ID token gerekli.')
    return finishGoogleLogin(idToken, validated)
  }

  async function exchangeGoogleCode(input: Record<string, unknown>) {
    const validated = validateLoginInput(input)
    const code = cleanText(input.code, 4096)
    const codeVerifier = cleanText(input.codeVerifier, 128)
    const redirectUri = cleanText(input.redirectUri, 1000)
    if (!code) throw new AuthError(400, 'missing_code', 'Google yetkilendirme kodu gerekli.')
    const idToken = await googleProvider.exchangeAuthorizationCode({
      code,
      codeVerifier,
      clientId: validated.clientId,
      redirectUri,
    })
    return finishGoogleLogin(idToken, validated)
  }

  async function rotateRefreshToken(rawRefreshToken: string) {
    const nextRawToken = refreshToken()
    const result = await repository.rotateRefreshSession(
      refreshTokenHash(rawRefreshToken),
      refreshTokenHash(nextRawToken),
      new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    )
    if (result.status === 'reused') {
      throw new AuthError(401, 'refresh_token_reused', 'Yenileme tokenı tekrar kullanıldı; oturum ailesi iptal edildi.')
    }
    if (result.status !== 'ok') {
      throw new AuthError(401, 'invalid_refresh_token', 'Yenileme tokenı geçersiz veya süresi dolmuş.')
    }
    return tokenPair(result.identity, nextRawToken)
  }

  async function createCompanionTicket(identity: AuthIdentity) {
    if (identity.deviceRole !== 'desktop') {
      throw new AuthError(403, 'desktop_required', 'Telefon oturumu yalnızca eşlenmiş PC tarafından verilebilir.')
    }
    if (!companionTickets) {
      throw new AuthError(503, 'companion_pairing_unavailable', 'Telefon oturumu eşleme servisi hazır değil.')
    }
    return companionTickets.issue(identity.accountId)
  }

  async function exchangeCompanionTicket(input: Record<string, unknown>) {
    if (!companionTickets) {
      throw new AuthError(503, 'companion_pairing_unavailable', 'Telefon oturumu eşleme servisi hazır değil.')
    }
    const ticket = cleanText(input.ticket, 100)
    const deviceKey = cleanText(input.deviceKey, 200)
    const deviceName = cleanText(input.deviceName, 80)
    if (!DEVICE_KEY_PATTERN.test(deviceKey)) {
      throw new AuthError(400, 'invalid_device_key', 'Telefon cihaz anahtarı geçersiz.')
    }
    if (!deviceName) throw new AuthError(400, 'invalid_device_name', 'Telefon cihaz adı gerekli.')
    const accountId = await companionTickets.consume(ticket)
    if (!accountId) {
      throw new AuthError(401, 'invalid_companion_ticket', 'Telefon eşleme bileti geçersiz veya süresi dolmuş.')
    }
    const rawRefreshToken = refreshToken()
    const identity = await repository.createCompanionSession(
      accountId,
      { deviceKey, deviceName },
      refreshTokenHash(rawRefreshToken),
      new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    )
    return tokenPair(identity, rawRefreshToken)
  }

  async function verifyAccessToken(rawAccessToken: string) {
    if (!rawAccessToken || rawAccessToken.length > 10_000) {
      throw new AuthError(401, 'invalid_access_token', 'Erişim tokenı gerekli.')
    }
    let payload
    try {
      ({ payload } = await jwtVerify(rawAccessToken, signingKey, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['HS256'],
      }))
    } catch {
      throw new AuthError(401, 'invalid_access_token', 'Erişim tokenı geçersiz veya süresi dolmuş.')
    }
    const accountId = cleanText(payload.sub, 100)
    const deviceId = cleanText(payload.device_id, 100)
    const sessionId = cleanText(payload.session_id, 100)
    const identity = await repository.resolveAccessSession(accountId, deviceId, sessionId)
    if (!identity) throw new AuthError(401, 'revoked_access_token', 'Oturum veya cihaz iptal edilmiş.')
    return identity
  }

  async function logout(identity: AuthIdentity) {
    return repository.revokeSessionFamily(identity.accountId, identity.sessionId)
  }

  async function revokeCurrentDevice(identity: AuthIdentity) {
    return repository.revokeDevice(identity.accountId, identity.deviceId)
  }

  return {
    config,
    exchangeGoogleCode,
    loginWithGoogleIdToken,
    rotateRefreshToken,
    createCompanionTicket,
    exchangeCompanionTicket,
    verifyAccessToken,
    logout,
    revokeCurrentDevice,
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.authorization || ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

function sendAuthError(response: Response, error: unknown) {
  const authError = error instanceof AuthError
    ? error
    : new AuthError(500, 'auth_internal_error', 'Kimlik işlemi tamamlanamadı.')
  if (!(error instanceof AuthError)) console.error('[Ritim Auth]', error)
  response.status(authError.status).json({
    ok: false,
    error: authError.code,
    message: authError.message,
  })
}

export function mountSocialAuthRoutes(
  app: Express,
  service: ReturnType<typeof createSocialAuthService> | undefined,
  config: SocialAuthConfig,
) {
  app.get('/auth/config', (_request, response) => {
    response.json({
      configured: config.configured,
      required: config.required,
      authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
      scopes: GOOGLE_SCOPES,
      responseType: 'code',
      codeChallengeMethod: 'S256',
      stateRequired: true,
      googleClientIds: config.googleClientIds,
    })
  })

  const requireService = (
    handler: (request: Request, response: Response) => Promise<void>,
  ) => async (request: Request, response: Response) => {
    if (!service) {
      response.status(503).json({
        ok: false,
        error: 'auth_not_configured',
        message: 'Ritim kimlik servisi yapılandırılmamış.',
      })
      return
    }
    try {
      await handler(request, response)
    } catch (error) {
      sendAuthError(response, error)
    }
  }

  app.post('/auth/google/exchange', requireService(async (request, response) => {
    response.json(await service!.exchangeGoogleCode(request.body || {}))
  }))
  app.post('/auth/google/id-token', requireService(async (request, response) => {
    response.json(await service!.loginWithGoogleIdToken(request.body || {}))
  }))
  app.post('/auth/refresh', requireService(async (request, response) => {
    response.json(await service!.rotateRefreshToken(cleanText(request.body?.refreshToken, 200)))
  }))
  app.post('/auth/companion/exchange', requireService(async (request, response) => {
    response.json(await service!.exchangeCompanionTicket(request.body || {}))
  }))

  const requireAccessToken = (
    handler: (request: Request, response: Response, identity: AuthIdentity) => Promise<void>,
  ) => requireService(async (request, response) => {
    const identity = await service!.verifyAccessToken(bearerToken(request))
    await handler(request, response, identity)
  })

  app.post('/auth/logout', requireAccessToken(async (_request, response, identity) => {
    await service!.logout(identity)
    response.status(204).end()
  }))
  app.post('/auth/companion-ticket', requireAccessToken(async (_request, response, identity) => {
    response.json(await service!.createCompanionTicket(identity))
  }))
  app.delete('/auth/device/current', requireAccessToken(async (_request, response, identity) => {
    await service!.revokeCurrentDevice(identity)
    response.status(204).end()
  }))
}

export function createSocketAuthentication(
  service: ReturnType<typeof createSocialAuthService> | undefined,
  config: SocialAuthConfig,
) {
  return async (
    socket: {
      handshake: { auth?: Record<string, unknown>; headers?: Record<string, unknown> }
      data: Record<string, unknown>
    },
    next: (error?: Error) => void,
  ) => {
    const handshakeToken = cleanText(socket.handshake.auth?.accessToken, 10_000)
    const authorization = cleanText(socket.handshake.headers?.authorization, 10_100)
    const headerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    const token = handshakeToken || headerToken
    if (!token) {
      if (config.required) next(new Error('Ritim Social oturumu gerekli.'))
      else next()
      return
    }
    if (!service) {
      next(new Error('Ritim kimlik servisi yapılandırılmamış.'))
      return
    }
    try {
      socket.data.socialIdentity = await service.verifyAccessToken(token)
      next()
    } catch {
      next(new Error('Ritim Social oturumu geçersiz.'))
    }
  }
}
