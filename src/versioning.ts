export type RitimVersion = {
  normalized: string
  major: number
  minor: number
  patch: number
  prerelease?: { channel: 'alpha' | 'beta' | 'rc'; iteration: number }
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/
const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2 } as const
const CHANNEL_LABELS = { alpha: 'Alpha', beta: 'Beta', rc: 'RC' } as const

export function parseRitimVersion(value: string): RitimVersion | null {
  const normalized = String(value || '').trim().replace(/^v/i, '')
  const match = VERSION_PATTERN.exec(normalized)
  if (!match) return null
  const iteration = match[5] ? Number(match[5]) : 0
  if (match[4] && iteration < 1) return null
  return {
    normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? { channel: match[4] as 'alpha' | 'beta' | 'rc', iteration }
      : undefined,
  }
}

export function compareRitimVersions(leftValue: string, rightValue: string) {
  const left = parseRitimVersion(leftValue)
  const right = parseRitimVersion(rightValue)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  const channelDifference = CHANNEL_RANK[left.prerelease.channel] - CHANNEL_RANK[right.prerelease.channel]
  if (channelDifference) return channelDifference > 0 ? 1 : -1
  if (left.prerelease.iteration === right.prerelease.iteration) return 0
  return left.prerelease.iteration > right.prerelease.iteration ? 1 : -1
}

export function isNewerRitimVersion(candidate: string, current: string) {
  return compareRitimVersions(candidate, current) > 0
}

// Short label for Settings ("Beta 2", "RC 1", "Kararlı"); derived from the
// package version so it cannot go stale between releases.
export function ritimReleaseLabel(value: string) {
  const parsed = parseRitimVersion(value)
  if (!parsed) return ''
  return parsed.prerelease
    ? `${CHANNEL_LABELS[parsed.prerelease.channel]} ${parsed.prerelease.iteration}`
    : 'Kararlı'
}

export function acceptsPrereleaseUpdates(current: string) {
  const parsed = parseRitimVersion(current)
  return current === '0.9.0' || Boolean(parsed?.prerelease)
}
