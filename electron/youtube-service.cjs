const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_URL = 'https://www.googleapis.com/youtube/v3'

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function parseDuration(value = 'PT0S') {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!match) return 0
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)
}

function decodeText(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function thumbnailOf(snippet) {
  const thumbnails = snippet?.thumbnails || {}
  return thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url
}

function createYouTubeService({ userDataPath, shell, safeStorage }) {
  const configPath = path.join(userDataPath, 'youtube-config.bin')
  const tokenPath = path.join(userDataPath, 'youtube-token.bin')
  let configCache
  let tokenCache
  let signInPromise

  async function readSecure(filePath) {
    try {
      const data = await fs.readFile(filePath)
      const encrypted = data.subarray(0, 4).toString() === 'enc:'
      const payload = data.subarray(encrypted ? 4 : 6)
      const text = encrypted ? safeStorage.decryptString(payload) : payload.toString('utf8')
      return JSON.parse(text)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async function writeSecure(filePath, value) {
    const text = JSON.stringify(value)
    const data = safeStorage.isEncryptionAvailable()
      ? Buffer.concat([Buffer.from('enc:'), safeStorage.encryptString(text)])
      : Buffer.concat([Buffer.from('plain:'), Buffer.from(text)])
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, data)
  }

  async function getConfig() {
    if (configCache === undefined) configCache = await readSecure(configPath)
    if (!configCache && process.env.RITIM_GOOGLE_CLIENT_ID) {
      configCache = {
        clientId: process.env.RITIM_GOOGLE_CLIENT_ID,
        clientSecret: process.env.RITIM_GOOGLE_CLIENT_SECRET || '',
      }
    }
    return configCache
  }

  async function getToken() {
    if (tokenCache === undefined) tokenCache = await readSecure(tokenPath)
    return tokenCache
  }

  async function configure({ clientId, clientSecret = '' }) {
    const cleanId = String(clientId || '').trim()
    const cleanSecret = String(clientSecret || '').trim()
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cleanId)) throw new Error('Geçerli bir Google Desktop OAuth istemci kimliği girin.')
    if (cleanSecret.length > 256) throw new Error('İstemci gizli anahtarı geçersiz.')
    configCache = { clientId: cleanId, clientSecret: cleanSecret }
    await writeSecure(configPath, configCache)
    return status()
  }

  async function exchangeToken(parameters) {
    const config = await getConfig()
    if (!config) throw new Error('Google OAuth yapılandırılmamış.')
    const body = new URLSearchParams({ client_id: config.clientId, ...parameters })
    if (config.clientSecret) body.set('client_secret', config.clientSecret)
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error_description || payload.error || 'Google token isteği başarısız.')
    tokenCache = {
      ...tokenCache,
      ...payload,
      expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
    }
    await writeSecure(tokenPath, tokenCache)
    return tokenCache
  }

  async function accessToken() {
    const token = await getToken()
    if (!token) throw new Error('YouTube hesabı bağlı değil.')
    if (token.access_token && token.expires_at > Date.now() + 60000) return token.access_token
    if (!token.refresh_token) throw new Error('Google oturumu yenilenemiyor; hesabı yeniden bağlayın.')
    const refreshed = await exchangeToken({ grant_type: 'refresh_token', refresh_token: token.refresh_token })
    return refreshed.access_token
  }

  async function api(resource, parameters = {}) {
    const token = await accessToken()
    const url = new URL(`${API_URL}/${resource}`)
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json()
    if (!response.ok) {
      const message = payload.error?.message || `YouTube API hatası (${response.status})`
      throw new Error(message)
    }
    return payload
  }

  async function status() {
    const config = await getConfig()
    const token = await getToken()
    const result = { available: true, configured: Boolean(config?.clientId), authenticated: Boolean(token?.refresh_token || (token?.access_token && token.expires_at > Date.now())) }
    if (!result.authenticated) return result
    try {
      const channels = await api('channels', { part: 'snippet', mine: true, maxResults: 1 })
      result.channelTitle = channels.items?.[0]?.snippet?.title
    } catch (error) {
      if (/invalid|expired|unauth/i.test(error.message)) result.authenticated = false
    }
    return result
  }

  async function signIn() {
    if (signInPromise) return signInPromise
    const config = await getConfig()
    if (!config) throw new Error('Önce Google OAuth istemci bilgilerini kaydedin.')

    signInPromise = new Promise((resolve, reject) => {
      const verifier = base64url(crypto.randomBytes(64))
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
      const expectedState = base64url(crypto.randomBytes(24))
      let settled = false
      let timeout

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        server.close()
        signInPromise = null
        if (error) reject(error)
        else resolve(value)
      }

      const server = http.createServer(async (request, response) => {
        try {
          const requestUrl = new URL(request.url, 'http://127.0.0.1')
          if (requestUrl.pathname !== '/oauth2callback') {
            response.writeHead(404).end()
            return
          }
          if (requestUrl.searchParams.get('state') !== expectedState) throw new Error('OAuth güvenlik doğrulaması başarısız.')
          const oauthError = requestUrl.searchParams.get('error')
          if (oauthError) throw new Error(oauthError === 'access_denied' ? 'Google bağlantısı iptal edildi.' : `Google OAuth hatası: ${oauthError}`)
          const code = requestUrl.searchParams.get('code')
          if (!code) throw new Error('Google yetkilendirme kodu gelmedi.')
          const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`
          await exchangeToken({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><meta charset="utf-8"><title>Ritim bağlandı</title><style>body{margin:0;display:grid;place-items:center;height:100vh;background:#090909;color:#fff;font:16px system-ui}main{text-align:center}b{color:#ff4d5a;font-size:28px}</style><main><b>Ritim bağlandı</b><p>Bu pencereyi kapatıp uygulamaya dönebilirsin.</p></main>')
          finish(null, await status())
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end(error.message)
          finish(error)
        }
      })

      server.on('error', (error) => finish(error))
      server.listen(0, '127.0.0.1', async () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`
        const authUrl = new URL(AUTH_URL)
        authUrl.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: YOUTUBE_SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: expectedState,
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'true',
        }).toString()
        try {
          await shell.openExternal(authUrl.toString())
        } catch (error) {
          finish(error)
        }
      })
      timeout = setTimeout(() => finish(new Error('Google giriş süresi doldu.')), 180000)
    })

    return signInPromise
  }

  async function signOut() {
    tokenCache = null
    await fs.rm(tokenPath, { force: true })
    return status()
  }

  async function hydrateTracks(items, collection) {
    const ids = [...new Set(items.map((item) => item.videoId).filter(Boolean))].slice(0, 50)
    if (ids.length === 0) return []
    const details = await api('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') })
    const detailMap = new Map(details.items.map((item) => [item.id, item]))
    return ids.flatMap((videoId, index) => {
      const video = detailMap.get(videoId)
      if (!video || video.status?.embeddable === false) return []
      return [{
        id: `yt:${videoId}`,
        youtubeVideoId: videoId,
        title: decodeText(video.snippet?.title || items.find((item) => item.videoId === videoId)?.title || 'YouTube videosu'),
        artist: decodeText(video.snippet?.channelTitle || items.find((item) => item.videoId === videoId)?.artist || 'YouTube'),
        collection,
        duration: Math.max(1, parseDuration(video.contentDetails?.duration)),
        cover: index % 6,
        thumbnailUrl: thumbnailOf(video.snippet) || items.find((item) => item.videoId === videoId)?.thumbnailUrl,
        source: 'youtube',
      }]
    })
  }

  async function playlists() {
    const payload = await api('playlists', { part: 'snippet,contentDetails', mine: true, maxResults: 25 })
    const own = (payload.items || []).map((item) => ({
      id: item.id,
      title: decodeText(item.snippet?.title || 'Çalma listesi'),
      itemCount: Number(item.contentDetails?.itemCount || 0),
      thumbnailUrl: thumbnailOf(item.snippet),
    }))
    return [{ id: '__liked__', title: 'Beğendiğim videolar', itemCount: 0 }, ...own]
  }

  async function liked() {
    const payload = await api('videos', { part: 'snippet,contentDetails,status', myRating: 'like', maxResults: 50 })
    return (payload.items || []).filter((video) => video.status?.embeddable !== false).map((video, index) => ({
      id: `yt:${video.id}`,
      youtubeVideoId: video.id,
      title: decodeText(video.snippet?.title || 'YouTube videosu'),
      artist: decodeText(video.snippet?.channelTitle || 'YouTube'),
      collection: 'Beğendiğim videolar',
      duration: Math.max(1, parseDuration(video.contentDetails?.duration)),
      cover: index % 6,
      thumbnailUrl: thumbnailOf(video.snippet),
      source: 'youtube',
    }))
  }

  async function home() {
    const [playlistItems, likedTracks] = await Promise.all([playlists(), liked()])
    return { playlists: playlistItems, tracks: likedTracks }
  }

  async function playlistItems({ playlistId, title }) {
    if (playlistId === '__liked__') return liked()
    if (!/^[\w-]{8,80}$/.test(String(playlistId || ''))) throw new Error('Çalma listesi kimliği geçersiz.')
    const payload = await api('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: 50 })
    const items = (payload.items || []).map((item) => ({
      videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
      title: item.snippet?.title,
      artist: item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle,
      thumbnailUrl: thumbnailOf(item.snippet),
    }))
    return hydrateTracks(items, String(title || 'YouTube çalma listesi').slice(0, 120))
  }

  async function search(query) {
    const cleanQuery = String(query || '').trim().slice(0, 120)
    if (cleanQuery.length < 2) throw new Error('Arama için en az iki karakter girin.')
    const payload = await api('search', {
      part: 'snippet', q: cleanQuery, type: 'video', maxResults: 20,
      videoCategoryId: 10, videoEmbeddable: true, relevanceLanguage: 'tr', safeSearch: 'moderate',
    })
    const items = (payload.items || []).map((item) => ({
      videoId: item.id?.videoId,
      title: item.snippet?.title,
      artist: item.snippet?.channelTitle,
      thumbnailUrl: thumbnailOf(item.snippet),
    }))
    return hydrateTracks(items, `Arama: ${cleanQuery}`)
  }

  return { configure, home, playlistItems, search, signIn, signOut, status }
}

module.exports = { createYouTubeService }
