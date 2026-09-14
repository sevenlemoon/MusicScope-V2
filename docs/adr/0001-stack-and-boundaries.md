# ADR 0001: stack and provider boundaries

Status: accepted for R0

MusicScope V2 uses Next.js + TypeScript, FastAPI + Python, SQLAlchemy/Alembic, and PostgreSQL in a modular monolith. This matches the product's UI needs, Python audio/ML ecosystem, typed schema needs, and Apple-Silicon local workflow while avoiding premature microservices.

External music, metadata, and concert systems are accessed only through backend provider ports. The first music adapter is a non-functional `NetEaseProvider` placeholder in R0; real private API behavior is deferred to R1 and must keep credentials server-side.

