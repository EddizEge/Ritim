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

function assertTagMatchesVersion(tag, version) {
  const normalizedTag = String(tag || '').trim().replace(/^v/i, '')
  const normalizedVersion = parseVersion(version).normalized
  if (normalizedTag !== normalizedVersion) {
    throw new Error(`Yayın etiketi (${tag}) paket sürümüyle (${normalizedVersion}) eşleşmiyor.`)
  }
  return true
}

module.exports = { androidVersionCode, assertTagMatchesVersion, parseVersion, updateChannel }
