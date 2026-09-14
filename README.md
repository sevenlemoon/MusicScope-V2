# MusicScope V2

MusicScope V2 is a greenfield personal music intelligence application. R0 provides a working full-stack shell and the domain/provider boundaries needed for real NetEase Cloud Music connection work in R1. It does **not** claim that QR login, library sync, recommendations, concert providers, or source separation are already integrated.

## Architecture

- `apps/web`: Next.js App Router + strict TypeScript frontend.
- `apps/api`: FastAPI modular monolith with SQLAlchemy 2 and Alembic.
- PostgreSQL 16: canonical music domain and sync/job persistence.
- Provider ports isolate music, metadata, and concert vendors from UI and domain code.
- Audio separation remains an offline background-job boundary; R0 does not invoke Demucs.

The database defaults to `musicscope_v2` on port `55432` with a V2-specific Compose project and volume. The API rejects PostgreSQL database names that do not contain `v2` to reduce the chance of touching the legacy database.

## Requirements

- Node.js 24.21.0 LTS (pinned in `.nvmrc` and `.node-version`)
- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Docker Desktop (only required for the PostgreSQL/full-stack path)

## Local development

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

Implemented and locally testable: route shell, design tokens/components, health/status APIs, domain schema, migrations, encrypted provider sessions, the NetEase adapter and read-only sidecar, QR state handling, library synchronization, and isolated development configuration.

Awaiting R1 human verification: real QR scan, authenticated profile, real library synchronization, artwork rendering, timing measurement, and repeated-sync database evidence. MusicScope ranking, live concert aggregation, and four-stem separation remain future phases.

See [`docs/R0_AUDIT.md`](docs/R0_AUDIT.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/R1_NETEASE_PLAN.md`](docs/R1_NETEASE_PLAN.md).
