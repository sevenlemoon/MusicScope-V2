# R0 audit and reference decisions

## Legacy MusicScope (read-only)

The legacy repository is a Next.js/FastAPI/PostgreSQL modular monolith with ten Alembic migrations. Its useful boundaries exist, but provider logic, serialization, and orchestration are concentrated in large modules (`routes.py`, `metadata.py`, and page components), and the product remains tied to a single fixed user plus import-first onboarding.

### PORT (selectively reimplement after V2 tests)

- Synchronized Web Audio transport concepts: one context clock, simultaneous source starts, pause/seek source recreation, per-stem gain.
- Audio artifact safety concepts: content probing, FFmpeg normalization, hash/config fingerprints, atomic promotion, controlled URLs.
- Evidence-bearing recommendation output and explicit exploration control.
- Honest concert source/status semantics and strict external URL handling.

### REWRITE

- Domain persistence: replace JSON `external_ids` and artist-only provider identities with a first-class cross-entity `ExternalIdentity`.
- User/account model: replace fixed personal/demo UUID assumptions with `User -> MusicConnection -> provider account`.
- Library sync: replace line-by-line import identity and repeated queries with provider-ID reconciliation, pagination, batching, and sync state.
- API modules: split the 700+ line route module into routers/services/provider ports.
- Audio jobs: replace the in-process executor with a durable database-backed worker boundary before production-like use; target four stems after benchmarking.
- Metadata enrichment: keep the conservative matching ideas, but make NetEase native metadata authoritative for NetEase entities.
- UI: rebuild the information architecture and responsive shell around Connect, Library, Discover, Live, Studio, and Insights.

### REFERENCE ONLY

- Profile/recommendation weighting and diversity heuristics; useful teaching material but currently ranks mainly the existing local catalog.
- Ticketmaster adapter, cached concert normalization, and the narrow artist-official-page adapter.
- Alembic/Compose developer workflow and deterministic unit-test techniques.
- iTunes adapter as a possible legacy/local/unknown fallback, subject to current terms and rate limits.

### DO NOT PORT

- Fixed personal/demo user IDs and any 2,427/2,500-track assumptions.
- CSV/TXT/helper-first onboarding and URL-import limitation as the core product journey.
- Title + primary artist matching as canonical identity.
- Demo fixtures, fabricated presentation data, old constellation homepage, two-stem-only product scope, renderer-held provider cookies, and monolithic global CSS/page modules.

## Open-source source review

Hydrogen Music source was inspected at its API wrappers, QR component, request/session utilities, store, and Electron service boundary. It creates a QR key, creates QR content/image, polls sequentially without overlapping requests, maps 801/802/803/800, cancels stale polling sessions, hydrates `/user/account`, pages `/user/playlist`, obtains full playlist IDs/details, and requests song/artist/album metadata through a local NetEase API service. Those state/race-handling concepts inform R1; its UI/assets and renderer-side cookie persistence do not.

YesPlayMusic source independently confirms the same key/create/check lifecycle and timestamped polling API wrapper. Feishin was reviewed for its provider-oriented music-client structure and dense responsive library/player information architecture. These are references only; no third-party code or visual assets were copied.

Primary references:

- <https://github.com/ldx123000/Hydrogen-Music>
- <https://github.com/qier222/YesPlayMusic>
- <https://github.com/jeffvli/feishin>

## Risks discovered

- NetEase endpoints are private/undocumented and can change, rate-limit, geo-restrict, or challenge accounts.
- QR success can return sensitive cookies. R0.1 now supplies a versioned AES-256-GCM storage
  envelope, server-only key configuration, metadata rejection, and recursive structured-log
  redaction. Rotation orchestration and logout semantics still require real R1 verification.
- Playlist APIs may return complete ID lists but partial track objects; batching limits must be measured rather than guessed.
- Provider terms and music playback rights are separate from metadata synchronization.
- Generic polymorphic external identities use a database type constraint plus the single
  `identity_resolution` service to validate the polymorphic target because one SQL foreign key
  cannot target several canonical tables.
- Four-stem Demucs inference has material model-download, memory, latency, storage, and Apple-Silicon compatibility risk.
- Concert API coverage, keys, quotas, matching, and ticket URL quality vary by market.
- FastAPI OpenAPI is authoritative; deterministic OpenAPI export, generated TypeScript types,
  and `make contract-check` now fail on cross-language contract drift.

## R0.1 environment blocker

Local lint, typecheck, tests, production build, Compose configuration, and fresh/existing database
migrations pass. Docker image compilation cannot begin because Docker Desktop times out while
fetching an OAuth token from `auth.docker.io` over IPv6. The same registry-auth timeout affects
independent Node and Python base-image metadata fetches, so this is classified as an environment
network blocker rather than an application or Dockerfile failure. It does not block local R1 work.
