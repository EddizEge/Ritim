// The social profile carries the listener's current track to other users.
// Players report a new position about every second; republishing each one made
// the gateway write PostgreSQL and rebuild every user's state once a second.
// Publish when something people can see changes, after a seek, or at most once
// per refresh interval while playing; viewers extrapolate the position between.
// Keep in sync with src/social/profilePublishPolicy.ts (shared parity test).
const SOCIAL_PROFILE_REFRESH_MS = 15_000
const SOCIAL_PROFILE_POSITION_JUMP_SECONDS = 4

function socialProfileSignature(profile) {
  const track = profile?.currentTrack
  return JSON.stringify([
    profile?.displayName,
    profile?.avatarUrl,
    track?.id,
    track?.videoId,
    track?.title,
    track?.artist,
    track?.duration,
    track?.thumbnailUrl,
    Boolean(track?.isPlaying),
  ])
}

function createSocialProfilePublisher({
  refreshMs = SOCIAL_PROFILE_REFRESH_MS,
  jumpSeconds = SOCIAL_PROFILE_POSITION_JUMP_SECONDS,
  now = () => Date.now(),
} = {}) {
  let last = null
  return {
    shouldPublish(profile) {
      if (!last) return true
      if (socialProfileSignature(profile) !== last.signature) return true
      const elapsedMs = now() - last.at
      const expectedPosition = last.position + (last.isPlaying ? elapsedMs / 1000 : 0)
      const position = Number(profile?.currentTrack?.position) || 0
      if (Math.abs(position - expectedPosition) > jumpSeconds) return true
      return last.isPlaying && elapsedMs >= refreshMs
    },
    remember(profile) {
      last = {
        signature: socialProfileSignature(profile),
        position: Number(profile?.currentTrack?.position) || 0,
        isPlaying: Boolean(profile?.currentTrack?.isPlaying),
        at: now(),
      }
    },
    reset() {
      last = null
    },
  }
}

module.exports = {
  SOCIAL_PROFILE_POSITION_JUMP_SECONDS,
  SOCIAL_PROFILE_REFRESH_MS,
  createSocialProfilePublisher,
  socialProfileSignature,
}
