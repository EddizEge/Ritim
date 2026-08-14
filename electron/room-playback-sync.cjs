const DRIFT_TOLERANCE_MS = 1500
const SEEK_COOLDOWN_MS = 5000
const FORCE_SEEK_DRIFT_MS = 8000
const MAX_EXTRAPOLATION_MS = 15000

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function updateClockEstimate(previous = {}, sample = {}) {
  const sentAtMs = finiteNumber(sample.clientSentAtMs)
  const receivedAtMs = Math.max(sentAtMs, finiteNumber(sample.clientReceivedAtMs, sentAtMs))
  const serverTimeMs = finiteNumber(sample.serverTimeMs)
  const sampleRoundTripMs = Math.max(0, receivedAtMs - sentAtMs)
  const sampleOffsetMs = serverTimeMs - (sentAtMs + sampleRoundTripMs / 2)
  const hasPrevious = Number.isFinite(previous.clockOffsetMs) && Number.isFinite(previous.roundTripMs)
  const weight = hasPrevious ? 0.25 : 1
  return {
    clockOffsetMs: hasPrevious
      ? previous.clockOffsetMs * (1 - weight) + sampleOffsetMs * weight
      : sampleOffsetMs,
    roundTripMs: hasPrevious
      ? previous.roundTripMs * (1 - weight) + sampleRoundTripMs * weight
      : sampleRoundTripMs,
    lastSampleRoundTripMs: sampleRoundTripMs,
    measuredAtMs: receivedAtMs,
  }
}

function expectedRoomPositionMs(playback, timing = {}) {
  const basePositionMs = Math.max(0, finiteNumber(playback?.playbackPositionMs))
  if (playback?.playbackState !== 'playing') return basePositionMs
  const localTimeMs = finiteNumber(timing.localTimeMs, Date.now())
  const clockOffsetMs = finiteNumber(timing.clockOffsetMs)
  const serverTimeMs = finiteNumber(playback?.serverTimeMs, localTimeMs + clockOffsetMs)
  const elapsedMs = Math.max(0, Math.min(
    MAX_EXTRAPOLATION_MS,
    localTimeMs + clockOffsetMs - serverTimeMs,
  ))
  return basePositionMs + elapsedMs
}

function planRoomPlaybackCorrection({
  playback,
  currentVideoId = '',
  currentPositionMs = 0,
  currentPlaybackState = 'paused',
  clockOffsetMs = 0,
  localTimeMs = Date.now(),
  lastSeekAtMs = 0,
  trackChanged = false,
} = {}) {
  const targetPositionMs = expectedRoomPositionMs(playback, { clockOffsetMs, localTimeMs })
  const actualPositionMs = Math.max(0, finiteNumber(currentPositionMs))
  const driftMs = targetPositionMs - actualPositionMs
  const absoluteDriftMs = Math.abs(driftMs)
  const videoChanged = trackChanged || String(currentVideoId || '') !== String(playback?.videoId || '')
  const cooldownActive = localTimeMs - Math.max(0, finiteNumber(lastSeekAtMs)) < SEEK_COOLDOWN_MS
  const seekRequired = videoChanged || (
    absoluteDriftMs > DRIFT_TOLERANCE_MS
    && (!cooldownActive || absoluteDriftMs >= FORCE_SEEK_DRIFT_MS)
  )
  const expectedPlaybackState = playback?.playbackState === 'playing' ? 'playing' : 'paused'
  const playbackStateRequired = currentPlaybackState !== expectedPlaybackState
  let reason = 'within_tolerance'
  if (videoChanged) reason = 'track_changed'
  else if (seekRequired) reason = 'drift_correction'
  else if (absoluteDriftMs > DRIFT_TOLERANCE_MS) reason = 'seek_cooldown'
  else if (playbackStateRequired) reason = 'playback_state_correction'
  return {
    targetPositionMs,
    actualPositionMs,
    driftMs,
    absoluteDriftMs,
    seekRequired,
    playbackStateRequired,
    expectedPlaybackState,
    reason,
  }
}

module.exports = {
  DRIFT_TOLERANCE_MS,
  SEEK_COOLDOWN_MS,
  FORCE_SEEK_DRIFT_MS,
  MAX_EXTRAPOLATION_MS,
  updateClockEstimate,
  expectedRoomPositionMs,
  planRoomPlaybackCorrection,
}
