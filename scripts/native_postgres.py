"""Start a private Windows PostgreSQL cluster, preserving existing databases."""
from __future__ import annotations

import argparse
import os
import socket
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

import psycopg
from psycopg import sql

from configure_local_env import bootstrap_environment, env_values


def install(root: Path, archive: Path, runtime: Path) -> Path:
    destination = root / '.tools' / 'postgresql-native-16.15'
    if not (destination / 'bin' / 'pg_ctl.exe').is_file():
        stage = Path(tempfile.mkdtemp(prefix='postgres-extract-', dir=root / '.tools'))
        with tarfile.open(archive) as bundle:
            bundle.extractall(stage, filter='data')
        for executable in ('postgres.exe', 'initdb.exe', 'pg_ctl.exe'):
            if not (stage / 'bin' / executable).is_file():
                raise RuntimeError('PostgreSQL archive is incomplete.')
        stage.rename(destination)
    # App-local Microsoft CRT avoids a separate admin-level redistributable install.
    for library in runtime.glob('*.dll'):
        target = destination / 'bin' / library.name
        if not target.exists():
            shutil.copy2(library, target)
    return destination / 'bin'


def prepare(root: Path, binaries: Path) -> None:
    environment = root / ".env"
    values = env_values(environment.read_text(encoding="utf-8"))
    url = values["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
    parts = urlsplit(url)
    port = parts.port or 5432
    user = unquote(parts.username or "")
    database = unquote(parts.path.lstrip("/"))
    password = unquote(parts.password or "")
    if parts.scheme != "postgresql" or parts.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Native launcher requires a loopback PostgreSQL URL.")
    if not user or not password or "v2" not in database.lower():
        raise RuntimeError("Invalid MusicScope V2 database configuration.")
    parent = root / "storage" / "postgres"
    data = parent / "data"
    log = root / ".logs" / "postgres.log"
    parent.mkdir(parents=True, exist_ok=True)
    log.parent.mkdir(parents=True, exist_ok=True)

    def run(name: str, *args: str) -> None:
        subprocess.run([str(binaries / f"{name}.exe"), *args], check=True)

    # An existing server is reused only after authentication with the configured URL.
    with socket.socket() as probe:
        occupied = probe.connect_ex(("127.0.0.1", port)) == 0
    if not occupied:
        if not (data / "PG_VERSION").exists():
            if data.exists() and any(data.iterdir()):
                raise RuntimeError("Incomplete database directory preserved; refusing to overwrite it.")
            print("Initializing native library database; any previous Docker volume remains untouched.", flush=True)
            # Publish only a complete cluster. Interrupted initialization remains
            # recoverable and does not prevent the next launch from trying again.
            staging = Path(tempfile.mkdtemp(prefix="initializing-", dir=parent))
            fd, name = tempfile.mkstemp(prefix="init-password-", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(password + "\n")
                run("initdb", "-D", str(staging), "-U", user, "--pwfile", name,
                    "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C")
                if data.exists():
                    data.rmdir()  # Only the empty directory accepted above.
                staging.rename(data)
            finally:
                Path(name).unlink(missing_ok=True)
        elif (data / "PG_VERSION").read_text().strip() != "16":
            raise RuntimeError("Unexpected PostgreSQL major version; data was not modified.")
        run("pg_ctl", "-D", str(data), "-l", str(log), "-w", "-t", "60",
            "-o", f"-h 127.0.0.1 -p {port}", "start")
    with psycopg.connect(host="127.0.0.1", port=port, user=user, password=password,
                         dbname="postgres", autocommit=True, connect_timeout=5) as connection:
        if not connection.execute("SELECT 1 FROM pg_database WHERE datname=%s", (database,)).fetchone():
            actual_data = Path(connection.execute("SHOW data_directory").fetchone()[0])
            if actual_data.resolve() != data.resolve():
                raise RuntimeError("Another server occupies the configured port; no database was created.")
            else:
                connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    with psycopg.connect(url, connect_timeout=5) as connection:
        if not values.get("SECRET_ENCRYPTION_KEY"):
            count = connection.execute(
                "SELECT count(*) FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name <> 'alembic_version'"
            ).fetchone()[0]
            if count:
                raise RuntimeError("Existing library has no encryption key. Restore its original .env.")
            bootstrap_environment(environment, allow_existing=True)
    print("Native database authenticated and ready.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()
    try:
        prepare(args.root, install(args.root, args.archive, args.runtime))
    except Exception as exc:
        # Never include the database URL or password in diagnostics.
        raise SystemExit(f"Database setup failed ({type(exc).__name__}): {exc}") from None
