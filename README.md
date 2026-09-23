# MusicScope V2

MusicScope V2 is a local-first personal music intelligence application with a connected music library, recommendation and live-concert intelligence, and a real four-stem audio Studio.

## Architecture

- `apps/web`: Next.js App Router + strict TypeScript frontend.
- `apps/api`: FastAPI modular monolith with SQLAlchemy 2 and Alembic.
- PostgreSQL 16: canonical music domain and sync/job persistence.
- Provider ports isolate music, metadata, and concert vendors from UI and domain code.
- `apps/audio-worker`: isolated Python 3.12 Demucs worker; Torch and model dependencies never enter FastAPI.

The database defaults to `musicscope_v2` on port `55432` with a V2-specific Compose project and volume. The API rejects PostgreSQL database names that do not contain `v2` to reduce the chance of touching the legacy database.

## Requirements

- Node.js 24.21.0 LTS (pinned in `.nvmrc` and `.node-version`)
- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Docker Desktop (only required for the PostgreSQL/full-stack path)

## Local development

The one-command launcher safely checks and reuses the local environment:

```bash
./scripts/dev.sh
```

It installs only missing or changed project dependencies, starts/reuses PostgreSQL, applies
forward Alembic migrations, starts the loopback NetEase sidecar, FastAPI, durable audio worker,
and Next.js, and opens
the web app. It never logs in, synchronizes, rebuilds recommendations, enriches artwork, deletes
data, or removes Docker volumes automatically.

Useful modes:

```bash
./scripts/dev.sh --setup     # dependencies, PostgreSQL, and migrations only
./scripts/dev.sh --status    # read-only status; starts nothing
./scripts/dev.sh --no-open   # normal start without opening a browser
```

Manual prerequisites are Docker Desktop, Node.js 24.21.x, Python 3.12+, and uv. The launcher
reports an actionable message when one is missing; it does not install system software or use
sudo. Optional provider credentials are not required for startup, and a fresh user reaches the
NetEase Connect/QR onboarding flow without a fabricated account or library.

For the lower-level commands, the following remains available:

```bash
cp .env.example .env
make install
docker compose up -d postgres
cd apps/api && .venv/bin/alembic upgrade head
```

Run the API, web app, and loopback-only NetEase sidecar in separate terminals:

```bash
make api-dev
make web-dev
make netease-api-dev
```

Open [http://localhost:3000](http://localhost:3000). API documentation is at [http://localhost:8100/docs](http://localhost:8100/docs). V2 uses host port 8100 to stay isolated from a running legacy API.

Alternatively, `make dev` starts the complete Compose stack.

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

## Current reality boundary

Implemented and locally testable: encrypted NetEase connection and library ingestion, recommendation intelligence, verified live-event aggregation, and R4.1 Studio. Studio accepts only user-selected local MP3/WAV/FLAC/M4A audio, validates it with ffprobe, queues durable PostgreSQL jobs, runs `htdemucs` in an isolated single-concurrency worker, publishes four validated FLAC stems and real waveform peaks, and serves user-scoped HTTP Range streams to the Web Audio mixer. Provider playback URLs are never processing inputs.

The first Studio model preparation downloads its worker-only weights into the user's external cache. Subjective separation quality on a user-owned commercial music file remains a user QA step; generated lawful audio covers the automated product path.

See [`docs/R0_AUDIT.md`](docs/R0_AUDIT.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/R1_NETEASE_PLAN.md`](docs/R1_NETEASE_PLAN.md).
