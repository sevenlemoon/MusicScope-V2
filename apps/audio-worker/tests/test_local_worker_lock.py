from sqlalchemy import create_engine

from audio_worker import worker


def test_local_worker_is_exclusive_and_releases_on_close(tmp_path, monkeypatch):
    engine = create_engine('sqlite+pysqlite:///' + (tmp_path / 'library.sqlite3').as_posix())
    monkeypatch.setattr(worker, 'get_engine', lambda: engine)
    first = worker._acquire_worker_lock()
    assert first is not None
    try:
        assert worker._acquire_worker_lock() is None
    finally:
        first.close()
    second = worker._acquire_worker_lock()
    assert second is not None
    second.close()
