.PHONY: install dev api-dev web-dev netease-api-dev lint typecheck test sidecar-check build contract-generate contract-check schema-check database-check compose-check check

install:
	uv sync --project apps/api --extra dev
	cd apps/web && npm install
	cd services/netease-api && npm install

dev:
	docker compose up --build

api-dev:
	cd apps/api && .venv/bin/uvicorn app.main:app --reload --port 8100

web-dev:
	cd apps/web && npm run dev

netease-api-dev:
	cd services/netease-api && npm start

lint:
	cd apps/api && .venv/bin/ruff check app tests alembic scripts
	cd apps/web && npm run lint

typecheck:
	cd apps/api && .venv/bin/python -m compileall -q app tests alembic scripts
	cd apps/web && npm run typecheck

test:
	cd apps/api && .venv/bin/pytest
	cd apps/web && npm test

sidecar-check:
	cd services/netease-api && npm test
	cd services/netease-api && npm audit --audit-level=moderate

build:
	cd apps/web && npm run build

contract-generate:
	cd apps/api && .venv/bin/python -m scripts.export_openapi ../../contracts/openapi.json
	cd apps/web && npm run contract:generate

contract-check:
	cd apps/api && .venv/bin/python -m scripts.export_openapi --check ../../contracts/openapi.json
	@tmp_file=$$(mktemp); \
	cd apps/web && ./node_modules/.bin/openapi-typescript ../../contracts/openapi.json -o "$$tmp_file" >/dev/null && \
	cmp -s lib/api-schema.generated.ts "$$tmp_file" && rm "$$tmp_file" || \
	{ status=$$?; rm -f "$$tmp_file"; echo "Frontend API types are stale; run make contract-generate"; exit $$status; }

schema-check:
	cd apps/api && .venv/bin/alembic heads
	cd apps/api && .venv/bin/alembic upgrade head --sql > /tmp/musicscope-v2-schema.sql

database-check:
	cd apps/api && .venv/bin/python -m scripts.validate_r1_database

compose-check:
	docker compose config --quiet

check: contract-check lint typecheck test sidecar-check schema-check database-check build compose-check
