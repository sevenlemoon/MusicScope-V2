# MusicScope V2 architecture

MusicScope is a local-first modular monolith: one Next.js client, one FastAPI service, one PostgreSQL database, provider adapters, a loopback NetEase sidecar, and an isolated local audio worker.

```text
Next.js / React / TypeScript
        -> FastAPI REST API
        -> application services
        -> PostgreSQL canonical domain
        -> provider ports and adapters
             -> NetEase sidecar
             -> concert providers / official sources
        -> durable StemJob queue
             -> audio worker / Demucs / FFmpeg
             -> private storage and Web Audio mixer
```

## Boundaries

- `apps/web`: App Router pages, shared shell, global locale, player, library/detail views, Discover, Live, Studio, and Insights.
- `apps/api/app/api`: HTTP routing and public response schemas.
- `apps/api/app/services`: synchronization, identity resolution, recommendations, concert aggregation, Insights, playback, and Studio lifecycle.
- `apps/api/app/domain`: SQLAlchemy entities and enums.
- `apps/api/app/providers`: provider contracts and adapters. Private provider protocols remain outside the browser.
- `apps/audio-worker`: isolated Python runtime, durable job claiming, Demucs execution, FLAC validation, waveform generation, and atomic publication.
- `services/netease-api`: loopback-only provider sidecar; session material is not exposed to frontend code.

## Canonical identity and privacy

`Track`, `Artist`, `Album`, and `Playlist` use internal UUIDs. `ExternalIdentity` maps provider/type/provider-ID tuples to one canonical record, preventing title matching from becoming the identity system. `MusicConnection` stores public connection state while encrypted provider sessions live only in `MusicConnectionSecret`; public API models never serialize secret fields.

On an empty installation, the first local API request creates one MusicScope user under a PostgreSQL transaction lock. This creates no provider connection, library item, profile, concert, or Studio job. Explicit user-ID requests still require an existing user.

The supported deployment is localhost-only. Compose publishes PostgreSQL, FastAPI, and the optional containerized web UI on `127.0.0.1`; the normal launcher also binds web, API, and the NetEase sidecar to loopback. Fresh setup generates a unique PostgreSQL password and server encryption key in ignored, owner-only `.env`, while an existing valid credential is reused. The `X-MusicScope-User-ID` request header is a local user-selection mechanism, **not remote authentication**. Remote or shared multi-user hosting is unsupported without real authentication, TLS/reverse-proxy policy, and a revised threat model.

## Recommendation and Insights boundaries

The recommendation path is deterministic and explainable:

```text
canonical library -> affinity -> co-occurrence/collaboration
                  -> rediscovery -> external candidates
                  -> bounded diversification
```

Music Universe uses the same canonical artists, library affinity, playlist co-occurrence, and collaboration evidence. It does not invent play counts, listening history, genre certainty, or psychological analysis.

## Live and Studio

Live aggregation isolates provider failures and preserves source provenance. A provider returning zero does not prove that an artist has no concerts. Studio accepts an explicit local upload, creates a durable `StemJob`, runs Demucs in the worker, validates four FLAC artifacts, generates waveform peaks, and serves user-scoped HTTP Range streams to a synchronized Web Audio mixer. NetEase playback streams are never processing inputs.
