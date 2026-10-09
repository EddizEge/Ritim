# Ritim — English

[Home](../README.md) · [Türkçe](README.tr.md) · [Latest release](../../releases/latest)

Ritim lets you use your own YouTube Music account in a dedicated Windows desktop window and control playback from an Android phone. The desktop runs the official `music.youtube.com` page. The Android side does not stream screenshots or video; it renders structured music data from the PC session in a native app shell.

## What works?

- YouTube Music home, personalized recommendations and persistent Google session
- Explore, search, library and category filters
- Artist, album and playlist details
- Play/pause, previous/next, seeking, volume, shuffle and repeat
- Now Playing and a de-duplicated queue
- Play next, remove and clear actions on the real YouTube Music queue
- Android notification and lock-screen play/pause, previous and next controls
- Sync V2 command acknowledgements, latency reporting, reconnect recovery and offline content cache
- Secure in-app QR pairing
- GitHub release checks on Windows and Android
- Discord Rich Presence

Audio is never relayed to the phone; the phone controls the player on the PC. Google cookies, passwords and session credentials are not sent to the phone. The local connection is protected by a random, app-session pairing token.

## Installation

1. Download and install the Windows package from [Releases](../../releases/latest).
2. Sign in to YouTube Music in the desktop window.
3. Install the Android APK attached to the same release.
4. Open **Settings** from the Ritim desktop toolbar.
5. Keep both devices on the same Wi-Fi network, tap **Scan QR code** in the Android app and scan the code shown by the PC.

Windows Firewall may ask for local-network access on first connection. Allow it only on a trusted private network.

## Updates

The packaged Windows app checks GitHub Releases. **Settings → Updates** separates checking, downloading, and **Restart and install**. Beta builds use the Beta channel. Moving from the historical Alpha builds to Beta 1 requires one manual installation.

The Android app selects an eligible GitHub release and tracks its download through the system Download Manager. Installation starts with user approval. Published APKs use Ritim's permanent signing certificate; a locally debug-signed development installation cannot be updated in place with that APK.

## Development

Requirements: Node.js 24+, npm, Windows 10/11 for Windows packaging, plus JDK 21 and Android SDK 36 for Android builds.

```powershell
npm ci
npm run desktop
```

Production builds:

```powershell
npm run dist:win
npm run android:apk
```

The Android debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

## Architecture

```text
Android Ritim ── local network / Socket.IO ── Windows Ritim ── official YouTube Music
   UI + controls                            bridge + audio      Google session
```

- Electron owns the official YouTube Music window and the local sync server.
- The desktop is the sole authoritative Sync V2 state source; phone commands carry unique IDs and receive desktop acknowledgements.
- The page bridge reads visible music metadata and player state only.
- The React/Capacitor Android app renders structured data with local UI components and exposes system media controls through Android MediaSession.
- Social features connect to the Raspberry Pi gateway over HTTPS/WSS; a person's PC and phone are separate devices on the same account.
- GitHub Actions publishes the Windows installer, channel-specific `latest.yml`/`beta.yml`/`rc.yml` metadata, and a permanently signed Android APK for tagged releases.

## Limitations

If Google changes YouTube Music’s page structure, the bridge selectors may need an update. Local Android builds default to a debug certificate; GitHub releases use Ritim's permanent certificate. The build variant name alone does not identify the signer. The PC and phone must be reachable on the same local network for local remote control; the social gateway does not relay that LAN connection.

At the user's request, Beta 1's final physical acceptance round is deferred; Beta 2 fixes the issues found in the handoff review. See the [Beta 2 release notes](releases/v0.9.1-beta.2.md), [Beta 1 release notes](releases/v0.9.1-beta.1.md), [roadmap](v0.9-roadmap.md), and [Claude handoff](CLAUDE_HANDOFF.md) for the scope and remaining work.

Ritim is an independent project and is not affiliated with, endorsed by, or sponsored by Google or YouTube.
