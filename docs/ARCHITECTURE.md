# MusicScope V2 architecture

## Decision

MusicScope V2 is a modular monolith: one Next.js client, one FastAPI service, one PostgreSQL database, and an isolated local audio worker for the ML workload.

```text
Next.js web
    -> MusicScope REST API
        -> application services
            -> canonical domain / PostgreSQL
            -> MusicProvider -> NetEase adapter
            -> MetadataProvider -> optional adapters
            -> ConcertProvider -> optional adapters
            -> PostgreSQL StemJob queue
                -> isolated audio worker -> FFmpeg / Demucs CLI
```

The browser never owns provider private-protocol behavior or provider cookies. Provider session
material is encrypted with server-configured AES-256-GCM before it enters
`MusicConnectionSecret`. Its versioned envelope is separated from ordinary
`MusicConnection` metadata, and public API response models never serialize secret fields.
Nested log structures are recursively redacted as a second, independent boundary.

## Modules

- `app/api`: HTTP routing and public response schemas.
- `app/core`: configuration, database, logging, and safety guards.
- `app/domain`: SQLAlchemy domain entities and enums.
- `app/providers`: ports plus vendor adapters. `NetEaseProvider` is an explicit R0 placeholder.
- `app/services`: orchestration such as connection state transitions, synchronization, live aggregation, and Studio upload/job lifecycle.
- `apps/audio-worker`: isolated locked runtime, durable job claiming, heartbeat/recovery, Demucs execution, FLAC validation, waveform generation, and atomic publication.

## Identity and provenance

Canonical `Track`, `Artist`, `Album`, and `Playlist` UUIDs are internal identities. `ExternalIdentity` maps a provider/type/provider-ID tuple to one canonical entity. This prevents title/artist matching from becoming the primary identity and lets the same NetEase track participate in many playlists without duplication.

`LibraryItem`, `PlaylistTrack`, `SyncState`, and correction/memory fields preserve where observations came from. Provider credentials live only in an authenticated-encryption envelope in `MusicConnectionSecret`; real provider credentials are still out of scope until R1.

`app.services.identity_resolution` is the single provider-ID resolution path. It validates the
entity type, verifies that the canonical row has the expected model, and relies on database
uniqueness to bind one provider/type/provider-ID tuple to one canonical entity.

## API contract

FastAPI's OpenAPI document is authoritative. `make contract-generate` exports the deterministic
schema to `contracts/openapi.json` and generates `apps/web/lib/api-schema.generated.ts` from it.
`make contract-check` fails when either checked-in artifact is stale; frontend code imports
public DTO types from that generated module instead of maintaining handwritten copies.

## Synchronization shape

R1 will reconcile account -> paginated playlists -> playlist track IDs -> batched song detail -> referenced artists/albums. Pages and batches are bounded; retries apply only to transient failures; commits occur in small idempotent units; unresolved minority records are retained with provenance instead of aborting the import.

## Live concert intelligence

Live concert discovery uses capability-declaring provider adapters behind a failure-isolating
aggregator. Normal Home, Artist, and Live feed reads use verified materialized records and make no
provider calls; explicit searches and refreshes apply bounded provider request budgets. Logical
events retain every provider source, while conservative reconciliation keeps uncertain matches
separate. See [LIVE_CONCERTS.md](LIVE_CONCERTS.md) for the provider matrix, identity rules, and
deferred-provider boundaries.

## Frontend

App Router supplies primary routes (`/`, `/discover`, `/library`, `/live`, `/studio`, `/insights`) and secondary routes. A responsive shell uses a desktop rail and recomposed mobile bottom navigation. R0 states are deliberately honest: no fake music, events, waveform, recommendations, or playback.

## Audio Studio

Studio keeps `PlaybackSource != ProcessingSource`: provider streams remain playback-only, while processing accepts an explicit local upload. FastAPI streams the upload into server-controlled storage, enforces byte/duration/quota limits, hashes it, and verifies the real container and single audio stream with ffprobe. A deterministic source-and-configuration fingerprint provides same-user successful-result reuse without cross-user sharing.

PostgreSQL is the durable queue. One worker holds the project advisory lock, claims rows transactionally, records a worker identity and heartbeat, and recovers stale work after a crash. It prepares canonical PCM, invokes Demucs 4.1.0 through an argument-array subprocess (MPS by default, validated CPU fallback), validates exactly four synchronized FLAC artifacts, generates real min/max waveform peaks, and atomically publishes job-owned output. Cancellation terminates only the owned process group.

The API never imports Torch or Demucs. Artifact and waveform endpoints enforce the authenticated user relationship; FLAC delivery supports private ETag caching and HTTP Range requests without revealing local paths. The browser streams four `HTMLMediaElement`s through `MediaElementAudioSourceNode`s, per-stem gain nodes, and a master gain node, with coordinated play/pause/seek and bounded drift correction. Real-time separation remains out of scope.
