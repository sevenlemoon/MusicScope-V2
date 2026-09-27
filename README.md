# MusicScope V2

MusicScope is a local-first audio separation tool. Import your own audio file, or connect NetEase and choose a playable song from your liked-music library, then separate it into six synchronized stems.

## What is implemented

- NetEase QR connection and read-only library synchronization
- A focused library view of liked tracks, their related albums, the liked-music playlist, and first-credited artists
- Two Studio sources: an independent local file or a currently playable song from the connected account
- Local six-stem Studio: Vocals, Drums, Bass, Guitar, Piano, and Other using Demucs
- A stem mixer with volume, mute/solo, speed, loop controls, waveform seeking, and FLAC downloads
- Earlier recommendation, concert, and Insights routes remain in the codebase but are not the primary workflow
- Chinese-first UI with a persisted Chinese/English language switch
- One-click local startup with guarded setup, migration, and service reuse

## Quick start

Requirements: macOS, Docker Desktop, Python 3.12+, and `uv`. For first-time setup, install [nvm](https://github.com/nvm-sh/nvm) in your user account, then run `nvm install` from this repository to install the pinned Node.js 24.21.0 runtime. The launcher selects that nvm version automatically, including when started from Finder; it does not replace system Node.

From Finder, double-click `MusicScope.command`.

From Terminal:

```bash
cd /path/to/MusicScope-V2
./scripts/dev.sh
```

Useful modes:

```bash
./scripts/dev.sh --status   # read-only health and migration report
./scripts/dev.sh --setup    # dependencies, PostgreSQL, and migrations only
./scripts/dev.sh --no-open  # start without opening a browser
```

The launcher reuses healthy PostgreSQL, the NetEase sidecar, FastAPI, the audio worker, and Next.js processes. It never synchronizes a provider, deletes data, or removes Docker volumes automatically. Fresh setup generates a unique database password and encryption key in ignored, owner-only `.env`; no shared database password is shipped. A fresh database reaches the Connect/QR onboarding state without demo data.

## Architecture

```text
Next.js + React + TypeScript
          -> FastAPI + SQLAlchemy
          -> PostgreSQL / canonical domain
          -> provider adapters -> NetEase sidecar and concert sources
          -> isolated audio worker -> Demucs -> six FLAC stems
```

The browser never receives provider session material. Canonical UUIDs and `ExternalIdentity` keep provider IDs separate from durable application identity. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md), and [`docs/RECOMMENDATIONS.md`](docs/RECOMMENDATIONS.md).

## Validation

```bash
make lint
make typecheck
make test
make schema-check
make contract-check
make build
make compose-check
```

## Honest boundaries

The library shows saved-music evidence, not listening frequency or play counts. Its artist category means the first credited artist, not a verified lead vocalist. Account-song separation depends on the connected account having a playable source for that song; some songs cannot be imported. An available source is downloaded to local Studio storage for processing, while signed playback URLs and account session material are not stored with the audio job. Only process music you have the right to use. Guitar and piano stems may contain bleed or artifacts; perfect isolation is not guaranteed. Studio processing is local and first-use model preparation may require a download.

MusicScope currently supports **local-machine deployment only**. The normal launcher and Compose host ports bind to `127.0.0.1`; PostgreSQL, FastAPI, the web UI, and the NetEase sidecar are not intended for LAN hosting. `X-MusicScope-User-ID` selects a local application user for development and tests; it is **not authentication**. A remote or shared multi-user deployment would need real authentication, TLS/reverse-proxy policy, and a new threat-model review.

## Project status

The current product direction is a focused six-stem separation tool for local-machine use. Existing four-stem jobs remain readable, while new Studio jobs use six stems. One-click startup requires the pinned nvm Node runtime described above.
