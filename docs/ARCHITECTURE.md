# MusicScope V2 architecture

MusicScope is a local-first modular monolith: one Next.js client, one FastAPI service, one PostgreSQL database, provider adapters, a loopback NetEase sidecar, and an isolated local audio worker.

```text
Next.js / React / TypeScript
        -> FastAPI REST API
        -> application services
        -> PostgreSQL canonical domain
        -> provider ports and adapters
             -> NetEase sidecar
        -> durable StemJob queue
             -> audio worker / Demucs / FFmpeg
             -> private storage and Web Audio mixer
```

## Boundaries

- `apps/web`: App Router pages, compact navigation, locale, player, library/detail views and six-stem Studio.
- `apps/api/app/api`: HTTP routing and public response schemas.
- `apps/api/app/services`: synchronization, identity resolution, playback and Studio lifecycle.
- `apps/api/app/domain`: SQLAlchemy entities and enums.
- `apps/api/app/providers`: provider contracts and adapters. Private provider protocols remain outside the browser.
- `apps/audio-worker`: isolated Python runtime, durable job claiming, Demucs execution, FLAC validation, waveform generation, and atomic publication.
- `services/netease-api`: loopback-only provider sidecar; session material is not exposed to frontend code.

## Canonical identity and privacy

`Track`, `Artist`, `Album`, and `Playlist` use internal UUIDs. `ExternalIdentity` maps provider/type/provider-ID tuples to one canonical record, preventing title matching from becoming the identity system. `MusicConnection` stores public connection state while encrypted provider sessions live only in `MusicConnectionSecret`; public API models never serialize secret fields.

On an empty installation, the first local API request creates one MusicScope user under a PostgreSQL transaction lock. This creates no provider connection, library item, profile, concert, or Studio job. Explicit user-ID requests still require an existing user.

The supported deployment is localhost-only. Compose publishes PostgreSQL, FastAPI, and the optional containerized web UI on `127.0.0.1`; the normal launcher also binds web, API, and the NetEase sidecar to loopback. Fresh setup generates a unique PostgreSQL password and server encryption key in ignored, owner-only `.env`, while an existing valid credential is reused. The `X-MusicScope-User-ID` request header is a local user-selection mechanism, **not remote authentication**. Remote or shared multi-user hosting is unsupported without real authentication, TLS/reverse-proxy policy, and a revised threat model.

## Studio and compatibility

Studio accepts a local upload or a playable source resolved through the connected account, creates a durable `StemJob`, and runs six-stem Demucs in the worker. It validates FLAC artifacts, generates waveform peaks and estimated beats, and serves user-scoped HTTP Range streams to the synchronized mixer. Temporary provider URLs are not stored with jobs.

Recommendation, concert and Insights routes, services, providers and UI were retired. Historical SQLAlchemy tables and Alembic migrations remain for existing-database compatibility; cleanup does not drop user data. Earlier milestone documents describe historical work, not current product capabilities.

The Windows launcher prepares verified portable Node/uv/FFmpeg under ignored `.tools/`, synchronizes locked dependencies, initializes `storage/library.sqlite3`, then starts the loopback services. SQLite uses WAL, foreign keys, a busy timeout, and an OS-held exclusive worker lock. A new database starts with current metadata at the `0010_saved_albums` baseline; subsequent changes must provide SQLite-compatible Alembic migrations. Normal startup does not require Docker, WSL, virtualization, or a database service. `-LegacyDocker` retains access to installations that use PostgreSQL volumes; these volumes are never automatically deleted or migrated. Node dependencies are reinstalled only when their manifest/runtime fingerprint changes. The Windows desktop shell keeps its workspace under the user's application-data directory and embeds Studio in a sandboxed Electron window.
