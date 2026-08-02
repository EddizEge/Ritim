const assert = require('node:assert/strict')
const test = require('node:test')
const {
  updateClockEstimate,
  expectedRoomPositionMs,
  planRoomPlaybackCorrection,
} = require('../electron/room-playback-sync.cjs')

const playing = {
  videoId: 'alpha4-video',
  playbackPositionMs: 40_000,
  playbackState: 'playing',
  serverTimeMs: 100_000,
}

test('sunucu saati ve saat farkıyla beklenen oynatma pozisyonu hesaplanır', () => {
  assert.equal(expectedRoomPositionMs(playing, {
    localTimeMs: 101_500,
    clockOffsetMs: 100,
  }), 41_600)
  assert.equal(expectedRoomPositionMs({ ...playing, playbackState: 'paused' }, {
    localTimeMs: 120_000,
    clockOffsetMs: 500,
  }), 40_000)
})

test('küçük sapma oynatıcıya müdahale etmez', () => {
  const plan = planRoomPlaybackCorrection({
    playback: playing,
    currentVideoId: playing.videoId,
    currentPositionMs: 41_000,
    currentPlaybackState: 'playing',
    localTimeMs: 101_500,
  })
  assert.equal(plan.seekRequired, false)
  assert.equal(plan.playbackStateRequired, false)
  assert.equal(plan.reason, 'within_tolerance')
})

test('büyük sapma kontrollü seek üretir', () => {
  const plan = planRoomPlaybackCorrection({
    playback: playing,
    currentVideoId: playing.videoId,
    currentPositionMs: 30_000,
    currentPlaybackState: 'playing',
    localTimeMs: 102_000,
  })
  assert.equal(plan.seekRequired, true)
  assert.equal(plan.reason, 'drift_correction')
  assert.equal(plan.targetPositionMs, 42_000)
})

test('seek koruması orta sapmayı bastırır fakat ciddi sapmayı hemen düzeltir', () => {
  const cooldown = planRoomPlaybackCorrection({
    playback: playing,
    currentVideoId: playing.videoId,
    currentPositionMs: 38_000,
    currentPlaybackState: 'playing',
    localTimeMs: 102_000,
    lastSeekAtMs: 100_000,
  })
  assert.equal(cooldown.seekRequired, false)
  assert.equal(cooldown.reason, 'seek_cooldown')

  const forced = planRoomPlaybackCorrection({
    playback: playing,
    currentVideoId: playing.videoId,
    currentPositionMs: 20_000,
    currentPlaybackState: 'playing',
    localTimeMs: 102_000,
    lastSeekAtMs: 100_000,
  })
  assert.equal(forced.seekRequired, true)
})

test('oynat/duraklat farkı seek olmadan düzeltilebilir', () => {
  const plan = planRoomPlaybackCorrection({
    playback: { ...playing, playbackState: 'paused' },
    currentVideoId: playing.videoId,
    currentPositionMs: 40_200,
    currentPlaybackState: 'playing',
    localTimeMs: 100_500,
  })
  assert.equal(plan.seekRequired, false)
  assert.equal(plan.playbackStateRequired, true)
  assert.equal(plan.reason, 'playback_state_correction')
})

test('gecikme örnekleri saat farkını ve RTT değerini yumuşatır', () => {
  const first = updateClockEstimate({}, {
    clientSentAtMs: 1_000,
    clientReceivedAtMs: 1_100,
    serverTimeMs: 1_070,
  })
  assert.equal(first.roundTripMs, 100)
  assert.equal(first.clockOffsetMs, 20)

  const second = updateClockEstimate(first, {
    clientSentAtMs: 2_000,
    clientReceivedAtMs: 2_200,
    serverTimeMs: 2_140,
  })
  assert.equal(second.roundTripMs, 125)
  assert.equal(second.clockOffsetMs, 25)
})
