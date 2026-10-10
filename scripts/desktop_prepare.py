"""Prepare desktop data with bundled Python; never install or download anything."""
from __future__ import annotations

import base64
import os
import secrets
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from configure_local_env import env_values, prepared_file
from prepare_local_database import prepare


def prepare_desktop(data: Path) -> None:
    data.mkdir(parents=True, exist_ok=True)
    environment = data / ".env"
    database = data / "storage" / "library.sqlite3"
    if environment.exists():
        values = env_values(environment.read_text(encoding="utf-8"))
        if not values.get("SECRET_ENCRYPTION_KEY"):
            raise RuntimeError("Local encryption key is missing. Restore the original .env; data was preserved.")
    else:
        if database.exists():
            raise RuntimeError("Existing library has no encryption key. Restore the original .env.")
        key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        temporary = prepared_file(environment, f"SECRET_ENCRYPTION_KEY={key}\n")
        try:
            # Exclusive creation: a second launcher must not overwrite a new key.
            os.link(temporary, environment)
        finally:
            temporary.unlink(missing_ok=True)
    prepare(database)

    # Only back up when a schema upgrade is needed; SQLite's backup API includes WAL.
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "apps" / "api" / "alembic.ini"))
    config.set_main_option("script_location", str(root / "apps" / "api" / "alembic"))
    head = ScriptDirectory.from_config(config).get_current_head()
    with sqlite3.connect(database) as source:
        current = source.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        if current != head:
            backups = database.parent / "backups"
            backups.mkdir(exist_ok=True)
            name = datetime.now(UTC).strftime("library-before-upgrade-%Y%m%dT%H%M%S%f.sqlite3")
            with sqlite3.connect(backups / name) as target:
                source.backup(target)


if __name__ == "__main__":
    prepare_desktop(Path(os.environ["MUSICSCOPE_DATA_DIR"]))
    print("Local data ready; account keys and library preserved.")
