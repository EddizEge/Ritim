import assert from 'node:assert/strict'
import test from 'node:test'
import desktopPolicy from '../electron/social-profile-policy.cjs'
import { createSocialProfilePublisher as createMobilePublisher } from '../src/social/profilePublishPolicy'

type Profile = {
  displayName: string
  avatarUrl?: string
  currentTrack?: { id: string; videoId?: string; title: string; artist: string; duration: number; position: number; cover: number; isPlaying: boolean }
}

function profile(position: number, overrides: Partial<NonNullable<Profile['currentTrack']>> = {}, displayName = 'Ediz'): Profile {
  return {
    displayName,
    currentTrack: { id: 'ytmusic:video:abc', videoId: 'abc', title: 'Parça', artist: 'Sanatçı', duration: 240, position, cover: 0, isPlaying: true, ...overrides },
  }
}

const implementations = {
  'masaüstü (electron/social-profile-policy.cjs)': desktopPolicy.createSocialProfilePublisher,
  'telefon (src/social/profilePublishPolicy.ts)': createMobilePublisher,
}

for (const [name, createPublisher] of Object.entries(implementations)) {
  test(`${name}: profil yalnız görünür değişiklikte, sarmada veya 15 sn'de bir gönderilir`, () => {
    let clock = 1_000_000
    const publisher = createPublisher({ now: () => clock })
    const publish = (next: Profile) => {
      const allowed = publisher.shouldPublish(next)
      if (allowed) publisher.remember(next)
      return allowed
    }

    assert.equal(publish(profile(10)), true, 'ilk profil gönderilir')
    let published = 0
    for (let second = 1; second <= 14; second += 1) {
      clock += 1_000
      if (publish(profile(10 + second))) published += 1
    }
    assert.equal(published, 0, 'çalarken her saniyelik konum güncellemesi gönderilmez')
    clock += 1_000
    assert.equal(publish(profile(25)), true, '15 saniye dolunca konum tazelenir')

    clock += 1_000
    assert.equal(publish(profile(90)), true, 'ileri sarma beklenen konumdan saptığı için gönderilir')
    clock += 1_000
    assert.equal(publish(profile(91, { isPlaying: false })), true, 'duraklatma hemen gönderilir')
    clock += 60_000
    assert.equal(publish(profile(91, { isPlaying: false })), false, 'duraklatılmışken tazeleme gerekmez')
    clock += 1_000
    assert.equal(publish(profile(30, { isPlaying: false })), true, 'duraklatılmışken sarma da gönderilir')
    clock += 1_000
    assert.equal(publish(profile(0, { id: 'ytmusic:video:def', videoId: 'def', title: 'Yeni' })), true, 'parça değişimi gönderilir')
    clock += 1_000
    assert.equal(publish(profile(1, { id: 'ytmusic:video:def', videoId: 'def', title: 'Yeni' }, 'Ediz Ege')), true, 'görünen ad değişimi gönderilir')

    publisher.reset()
    assert.equal(publisher.shouldPublish(profile(2, { id: 'ytmusic:video:def', videoId: 'def', title: 'Yeni' }, 'Ediz Ege')), true, 'yeniden bağlanınca ilk profil gönderilir')
  })
}
