import importlib.util
import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('desktop_database', ROOT / 'scripts/prepare_local_database.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def test_local_library_persists_and_matches_migration_metadata(tmp_path):
    path = tmp_path / 'with spaces' / 'library.sqlite3'
    module.prepare(path)
    url = 'sqlite+pysqlite:///' + path.as_posix()
    engine = create_engine(url)
    with engine.begin() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '0010_saved_albums'
        assert connection.scalar(text('SELECT count(*) FROM users')) == 1
        connection.execute(text("UPDATE users SET display_name='preserved'"))
    module.prepare(path)
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT display_name FROM users')) == 'preserved'
        assert connection.scalar(text('PRAGMA quick_check')) == 'ok'
    engine.dispose()
    result = subprocess.run([sys.executable, '-m', 'alembic', 'check'], cwd=ROOT / 'apps/api',
                            env={**os.environ, 'DATABASE_URL': url}, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
