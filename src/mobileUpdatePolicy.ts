import { compareRitimVersions, isNewerRitimVersion, parseRitimVersion } from './versioning'

export type GitHubRelease = {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name: string; browser_download_url: string }>
}

export type MobileUpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'development'

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

export function normalizeGitHubRepository(value: string) {
  const candidate = String(value || '').trim()
  const segments = candidate.split('/')
  return REPOSITORY_PATTERN.test(candidate)
    && segments.every((segment) => segment !== '.' && segment !== '..' && !segment.startsWith('.'))
    ? candidate
    : 'EddizEge/Ritim'
}

export function githubReleasesApiUrl(repository: string, page = 1) {
  const [owner, repo] = normalizeGitHubRepository(repository).split('/')
  const safePage = Math.min(5, Math.max(1, Math.trunc(page) || 1))
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100&page=${safePage}`
}

export function safeMobileUpdateAssetUrl(value: string | undefined, repository: string, expectedVersion = '') {
  if (!value) return ''
  try {
    const target = new URL(value)
    const prefix = `/${normalizeGitHubRepository(repository)}/releases/download/`.toLocaleLowerCase('en-US')
    const pathname = decodeURIComponent(target.pathname).toLocaleLowerCase('en-US')
    const remainder = pathname.slice(prefix.length)
    const remainderParts = remainder.split('/')
    const tag = remainderParts[0]?.replace(/^v/i, '') || ''
    const assetName = remainderParts[1] || ''
    const canonicalAssetName = expectedVersion
      ? `ritim-android-v${expectedVersion.toLocaleLowerCase('en-US')}.apk`
      : ''
    if (target.protocol !== 'https:' || target.hostname !== 'github.com' || target.port
      || target.username || target.password || target.search || target.hash
      || !pathname.startsWith(prefix) || !pathname.endsWith('.apk')
      || remainderParts.length !== 2
      || (expectedVersion && (tag !== expectedVersion.toLocaleLowerCase('en-US') || assetName !== canonicalAssetName))) return ''
    return target.toString()
  } catch {
    return ''
  }
}

export function mobileUpdateChannel(version: string) {
  if (version === '0.9.0') return 'beta'
  return parseRitimVersion(version)?.prerelease?.channel || 'latest'
}

const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2 } as const

export function acceptsReleaseForChannel(candidateVersion: string, currentVersion: string) {
  const candidate = parseRitimVersion(candidateVersion)
  const currentChannel = mobileUpdateChannel(currentVersion)
  if (!candidate) return false
  if (!candidate.prerelease) return true
  if (currentChannel === 'latest') return false
  return CHANNEL_RANK[candidate.prerelease.channel] >= CHANNEL_RANK[currentChannel]
}

export function selectMobileRelease(releases: GitHubRelease[], currentVersion: string) {
  return releases
    .filter((candidate) => {
      const version = String(candidate.tag_name || '').replace(/^v/i, '')
      return !candidate.draft
        && Boolean(parseRitimVersion(version))
        && acceptsReleaseForChannel(version, currentVersion)
        && isNewerRitimVersion(version, currentVersion)
    })
    .sort((left, right) => {
      const leftVersion = String(left.tag_name || '').replace(/^v/i, '')
      const rightVersion = String(right.tag_name || '').replace(/^v/i, '')
      return -compareRitimVersions(leftVersion, rightVersion)
    })[0]
}
