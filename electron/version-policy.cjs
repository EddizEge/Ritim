const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/

const STAGE_OFFSETS = {
  alpha: { offset: 0, max: 39 },
  beta: { offset: 40, max: 39 },
  rc: { offset: 80, max: 18 },
}

function parseVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '')
  const match = VERSION_PATTERN.exec(normalized)
  if (!match) throw new Error(`Geçersiz Ritim sürümü: ${value}`)
  const prerelease = match[4]
    ? { channel: match[4], iteration: Number(match[5]) }
    : null
  if (prerelease) {
    const policy = STAGE_OFFSETS[prerelease.channel]
    if (prerelease.iteration < 1 || prerelease.iteration > policy.max) {
      throw new Error(`Geçersiz ${prerelease.channel} sıra numarası: ${prerelease.iteration}`)
    }
  }
  return {
    normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function androidVersionCode(value) {
  const version = parseVersion(value)
  const stage = version.prerelease
    ? STAGE_OFFSETS[version.prerelease.channel].offset + version.prerelease.iteration
    : 99
  const code = version.major * 1_000_000 + version.minor * 10_000 + version.patch * 100 + stage
  if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error(`Android versionCode aralık dışında: ${code}`)
  }
  return code
}

function updateChannel(value) {
  return parseVersion(value).prerelease?.channel || 'latest'
}

// Update path shared with Android (src/mobileUpdatePolicy.ts): a client accepts
// its own channel and every more stable one, never a less stable one.
// alpha -> alpha, beta, rc, stable; beta -> beta, rc, stable; rc -> rc, stable;
// stable -> stable. Never a downgrade.
const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2, latest: 3 }

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (!a.prerelease || !b.prerelease) {
    if (!a.prerelease && !b.prerelease) return 0
    return a.prerelease ? -1 : 1
  }
  if (a.prerelease.channel !== b.prerelease.channel) {
    return CHANNEL_RANK[a.prerelease.channel] < CHANNEL_RANK[b.prerelease.channel] ? -1 : 1
  }
  if (a.prerelease.iteration === b.prerelease.iteration) return 0
  return a.prerelease.iteration < b.prerelease.iteration ? -1 : 1
}

function tryParseVersion(value) {
  try { return parseVersion(value) } catch { return null }
}

function acceptsReleaseForChannel(candidateVersion, currentVersion) {
  const candidate = tryParseVersion(candidateVersion)
  if (!candidate || !tryParseVersion(currentVersion)) return false
  const candidateChannel = candidate.prerelease?.channel || 'latest'
  return CHANNEL_RANK[candidateChannel] >= CHANNEL_RANK[updateChannel(currentVersion)]
}

// Highest release the current channel accepts, or '' when none. The caller
// still compares it with the current version; this never picks by feed order.
function selectUpdateVersion(candidateVersions, currentVersion) {
  let selected = ''
  for (const value of candidateVersions || []) {
    const candidate = tryParseVersion(value)
    if (!candidate || !acceptsReleaseForChannel(candidate.normalized, currentVersion)) continue
    if (!selected || compareVersions(candidate.normalized, selected) > 0) selected = candidate.normalized
  }
  return selected
}

function assertTagMatchesVersion(tag, version) {
  const normalizedTag = String(tag || '').trim().replace(/^v/i, '')
  const normalizedVersion = parseVersion(version).normalized
  if (normalizedTag !== normalizedVersion) {
    throw new Error(`Yayın etiketi (${tag}) paket sürümüyle (${normalizedVersion}) eşleşmiyor.`)
  }
  return true
}

module.exports = {
  acceptsReleaseForChannel,
  androidVersionCode,
  assertTagMatchesVersion,
  compareVersions,
  parseVersion,
  selectUpdateVersion,
  updateChannel,
}
