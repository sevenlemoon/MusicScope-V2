# MusicScope V2 architecture

## Decision

MusicScope V2 is a modular monolith: one Next.js client, one FastAPI service, one PostgreSQL database, and process boundaries only where workloads require them. This keeps the graduation project demonstrable and maintainable without preventing a future audio worker.

```text
Next.js web
    -> MusicScope REST API
        -> application services
            -> canonical domain / PostgreSQL
            -> MusicProvider -> NetEase adapter
            -> MetadataProvider -> optional adapters
            -> ConcertProvider -> optional adapters
            -> separation job runner -> FFmpeg / Demucs
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
- `app/services`: orchestration such as connection state transitions and future sync reconciliation.

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

## Audio

The legacy validated FFmpeg + `demucs-infer` pipeline is a reference for R3/R4. V2 targets four offline stems and a durable job runner. Model/runtime choice will be benchmarked again in the V2 environment before implementation; real-time separation remains out of scope.
