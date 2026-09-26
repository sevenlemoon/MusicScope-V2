# MusicScope V2

MusicScope is a local-first personal music intelligence and discovery app. It connects a NetEase library, keeps canonical music entities, explains recommendations, finds verified live events, and turns a local audio file into four synchronized stems in Studio.

## What is implemented

- NetEase QR connection and read-only library synchronization
- Canonical tracks, artists, albums, playlists, artwork, search, and playback
- Explainable recommendation and Discover flows (deterministic profile logic, not an LLM recommender)
- Multi-provider concert intelligence with provenance and honest partial coverage
- Local four-stem Studio: Vocals, Drums, Bass, and Other using Demucs
- Music Universe / Insights from library affinity, playlist co-occurrence, and collaboration evidence
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
          -> isolated audio worker -> Demucs -> four FLAC stems
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

Recommendations use library evidence, affinity, co-occurrence, collaborations, rediscovery, bounded diversification, and provider candidates. MusicScope does not claim complete listening history, play counts, psychological personality, or reliable genre/timeline analysis when those signals are absent. Concert coverage depends on configured sources. Studio processing is local and first-use model preparation may require a download; NetEase playback streams are never separation inputs.

MusicScope currently supports **local-machine deployment only**. The normal launcher and Compose host ports bind to `127.0.0.1`; PostgreSQL, FastAPI, the web UI, and the NetEase sidecar are not intended for LAN hosting. `X-MusicScope-User-ID` selects a local application user for development and tests; it is **not authentication**. A remote or shared multi-user deployment would need real authentication, TLS/reverse-proxy policy, and a new threat-model review.

## Project status

R1–R6 are checkpointed. MusicScope V2 is graduation-release ready for its supported local-machine deployment. One-click startup requires the pinned nvm Node runtime described above.
