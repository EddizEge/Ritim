const path = require('node:path')

// The packaged Social view loads the Vite build from a privileged standard
// scheme instead of file://, because the build uses absolute asset paths
// (Vite `base: '/'`, shared with Android and the Sync server).
const SOCIAL_SCHEME = 'ritim-app'
const SOCIAL_HOST = 'social'
const SOCIAL_PAGE_PATH = '/desktop-social.html'
const SOCIAL_PARTITION = 'ritim-social'
const DEFAULT_DEV_SERVER_URL = 'http://localhost:5173'

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

// Avatars and track artwork come from Google/YouTube image hosts over HTTPS;
// the shared stylesheet imports its font from Google Fonts.
const SOCIAL_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Vite emits `<script type="module" crossorigin>` and modulepreload links;
// Chromium loads those in CORS mode, which a custom scheme must opt into.
function socialSchemePrivileges() {
  return {
    scheme: SOCIAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }
}

function socialPageUrl({ isPackaged, devServerUrl = DEFAULT_DEV_SERVER_URL }) {
  if (isPackaged) return `${SOCIAL_SCHEME}://${SOCIAL_HOST}${SOCIAL_PAGE_PATH}`
  return new URL(SOCIAL_PAGE_PATH, devServerUrl).toString()
}

// The Social view may only stay on its own page; query and hash are ignored so
// development reloads keep working. `origin` is "null" for custom schemes, so
// protocol and host are compared explicitly.
function isSocialPageUrl(candidate, pageUrl) {
  try {
    const target = new URL(candidate)
    const page = new URL(pageUrl)
    return target.protocol === page.protocol
      && target.host === page.host
      && !target.username
      && !target.password
      && target.pathname === page.pathname
  } catch {
    return false
  }
}

function isExternalWebUrl(candidate) {
  try {
    const target = new URL(candidate)
    return target.protocol === 'https:' && !target.username && !target.password
  } catch {
    return false
  }
}

// Maps a `ritim-app://social/...` request to a file inside the Vite build.
// Returns null for other hosts, traversal attempts and unknown file types.
function resolveSocialAsset(distRoot, requestUrl) {
  let url
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${SOCIAL_SCHEME}:` || url.host !== SOCIAL_HOST) return null
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '') pathname = SOCIAL_PAGE_PATH
  if (pathname.includes('\0')) return null
  const root = path.resolve(distRoot)
  const filePath = path.resolve(root, `.${pathname}`)
  if (!filePath.startsWith(`${root}${path.sep}`)) return null
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()]
  if (!contentType) return null
  return { filePath, contentType }
}

function createSocialProtocolHandler({ distRoot, readFile }) {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }
    const asset = resolveSocialAsset(distRoot, request.url)
    if (!asset) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(asset.filePath)
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': asset.contentType,
          'content-security-policy': SOCIAL_PAGE_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}

module.exports = {
  DEFAULT_DEV_SERVER_URL,
  SOCIAL_HOST,
  SOCIAL_PAGE_CSP,
  SOCIAL_PAGE_PATH,
  SOCIAL_PARTITION,
  SOCIAL_SCHEME,
  createSocialProtocolHandler,
  isExternalWebUrl,
  isSocialPageUrl,
  resolveSocialAsset,
  socialPageUrl,
  socialSchemePrivileges,
}
