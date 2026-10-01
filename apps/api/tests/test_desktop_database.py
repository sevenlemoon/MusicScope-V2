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


def run_desktop_prepare(data):
    return subprocess.run(
        [sys.executable, str(ROOT / 'scripts/desktop_prepare.py')], cwd=ROOT,
        env={**os.environ, 'MUSICSCOPE_DATA_DIR': str(data)}, capture_output=True, text=True,
    )


def test_desktop_preparation_preserves_key_and_data_in_unicode_path(tmp_path):
    data = tmp_path / '用户资料 with spaces'
    first = run_desktop_prepare(data)
    assert first.returncode == 0, first.stdout + first.stderr
    original_key = (data / '.env').read_bytes()
    database = data / 'storage/library.sqlite3'
    engine = create_engine('sqlite+pysqlite:///' + database.as_posix())
    with engine.begin() as connection:
        connection.execute(text("UPDATE users SET display_name='keep me'"))
    second = run_desktop_prepare(data)
    assert second.returncode == 0, second.stdout + second.stderr
    assert (data / '.env').read_bytes() == original_key
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT display_name FROM users')) == 'keep me'
    assert not (data / 'storage/backups').exists()
    engine.dispose()


def test_desktop_refuses_to_replace_missing_encryption_key(tmp_path):
    database = tmp_path / 'storage/library.sqlite3'
    module.prepare(database)
    original = database.read_bytes()
    result = run_desktop_prepare(tmp_path)
    assert result.returncode != 0
    assert 'Restore the original .env' in result.stderr
    assert database.read_bytes() == original
    assert not (tmp_path / '.env').exists()
