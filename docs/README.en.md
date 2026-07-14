# Ritim — English

[Home](../README.md) · [Türkçe](README.tr.md) · [Latest release](../../releases/latest)

Ritim lets you use your own YouTube Music account in a dedicated Windows desktop window and control playback from an Android phone. The desktop runs the official `music.youtube.com` page. The Android side does not stream screenshots or video; it renders structured music data from the PC session in a native app shell.

## What works?

- YouTube Music home, personalized recommendations and persistent Google session
- Explore, search, library and category filters
- Artist, album and playlist details
- Play/pause, previous/next, seeking, volume, shuffle and repeat
- Now Playing and a de-duplicated queue
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

The packaged Windows app checks GitHub Releases at startup. You can also use **Settings → Check for updates**. When a download is ready, **Restart and install** appears.

The Android app checks the latest GitHub release at startup as well. When a newer APK is available it opens the download page; Android requires the user to approve installation.

## Development

Requirements: Node.js 24+, npm, Windows 10/11 for Windows packaging, plus JDK 21 and Android SDK 36 for Android builds.

```powershell
npm install
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
- The page bridge reads visible music metadata and player state only.
- The React/Capacitor Android app renders structured data with local UI components.
- GitHub Actions publishes the Windows installer, `latest.yml` updater metadata and a test APK for tagged releases.

## Limitations

If Google changes YouTube Music’s page structure, the bridge selectors may need an update. The Android build currently produces a debug-signed test APK; store distribution requires a dedicated release key. Both devices must be reachable on the same local network.

Ritim is an independent project and is not affiliated with, endorsed by, or sponsored by Google or YouTube.
