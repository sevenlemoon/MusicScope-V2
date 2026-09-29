"""Initialize the desktop's file database without changing PostgreSQL data."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps' / 'api'))

from sqlalchemy import create_engine, inspect, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.domain.models import Base, User  # noqa: E402

BASELINE = '0010_saved_albums'


def prepare(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        engine = create_engine('sqlite+pysqlite:///' + path.as_posix())
        try:
            with engine.connect() as connection:
                if connection.scalar(text('PRAGMA quick_check')) != 'ok':
                    raise RuntimeError('Library integrity check failed; file was preserved.')
                if 'alembic_version' not in inspect(connection).get_table_names():
                    raise RuntimeError('Unrecognized library file; refusing to replace it.')
        finally:
            engine.dispose()
        print('Existing local library preserved.')
        return
    fd, temporary = tempfile.mkstemp(prefix='library-init-', suffix='.sqlite3', dir=path.parent)
    os.close(fd)
    staged = Path(temporary)
    engine = create_engine('sqlite+pysqlite:///' + staged.as_posix())
    try:
        # Historical migrations target PostgreSQL. A fresh local database starts
        # from the equivalent current metadata and a pinned Alembic baseline.
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)'))
            connection.execute(text('INSERT INTO alembic_version VALUES (:version)'), {'version': BASELINE})
        with Session(engine) as session:
            session.add(User(display_name='MusicScope listener'))
            session.commit()
        engine.dispose()
        if path.exists():
            raise RuntimeError('Another launcher created the library. Reopen MusicScope to reuse it.')
        staged.rename(path)
        print('Local library initialized. No Docker, WSL or database service required.')
    finally:
        engine.dispose()
        staged.unlink(missing_ok=True)


if __name__ == '__main__':
    if not get_settings().secret_encryption_key:
        raise SystemExit('The local encryption key is missing; restore the original .env.')
    prepare(ROOT / 'storage' / 'library.sqlite3')
