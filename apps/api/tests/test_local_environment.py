import base64
import importlib.util
from pathlib import Path
from urllib.parse import urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("configure_local_env", ROOT / "scripts/configure_local_env.py")
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def test_fresh_environment_generates_unique_local_secrets(tmp_path: Path) -> None:
    environment = tmp_path / ".env"
    first = module.bootstrap_environment(environment, ROOT / ".env.example")
    assert first is True
    values = module.env_values(environment.read_text(encoding="utf-8"))
    password = values["POSTGRES_PASSWORD"]
    assert len(password) == 64
    assert not module.is_legacy_password(password)
    assert urlsplit(values["DATABASE_URL"]).password == password
    assert urlsplit(values["DATABASE_URL"]).hostname == "127.0.0.1"
    assert len(base64.urlsafe_b64decode(values["SECRET_ENCRYPTION_KEY"])) == 32
    assert environment.stat().st_mode & 0o777 == 0o600

    second = tmp_path / "second.env"
    module.bootstrap_environment(second, ROOT / ".env.example")
    assert module.env_values(second.read_text(encoding="utf-8"))["POSTGRES_PASSWORD"] != password
    assert module.bootstrap_environment(environment, allow_existing=True) is False
    assert module.env_values(environment.read_text(encoding="utf-8"))["POSTGRES_PASSWORD"] == password


def test_existing_environment_is_preserved_and_inconsistent_placeholder_rejected(tmp_path: Path) -> None:
    environment = tmp_path / ".env"
    contents = (ROOT / ".env.example").read_text(encoding="utf-8")
    contents = module.with_values(contents, {"POSTGRES_PASSWORD": "custom-password", "DATABASE_URL": ""})
    environment.write_text(contents, encoding="utf-8")
    assert module.bootstrap_environment(environment, allow_existing=True) is True
    values = module.env_values(environment.read_text(encoding="utf-8"))
    assert values["POSTGRES_PASSWORD"] == "custom-password"
    assert urlsplit(values["DATABASE_URL"]).password == "custom-password"

    bad = module.with_values(contents, {"POSTGRES_PASSWORD": "", "DATABASE_URL": values["DATABASE_URL"]})
    environment.write_text(bad, encoding="utf-8")
    with pytest.raises(RuntimeError, match="password is missing"):
        module.bootstrap_environment(environment, allow_existing=True)
    assert environment.read_text(encoding="utf-8") == bad


def test_password_replacement_refuses_mismatched_target() -> None:
    values = {"POSTGRES_USER": "musicscope_v2", "POSTGRES_DB": "musicscope_v2", "POSTGRES_PORT": "55432"}
    local_url = module.database_url(values, "old-password")
    replacement = module.replace_url_password(local_url, "old-password", "new-password", values)
    assert urlsplit(replacement).password == "new-password"
    with pytest.raises(RuntimeError, match="does not match"):
        remote_url = local_url.replace("127.0.0.1", "example.org")
        module.replace_url_password(remote_url, "old-password", "new", values)


def test_rotation_restores_old_role_password_if_env_replace_fails(tmp_path: Path, monkeypatch) -> None:
    import psycopg

    environment = tmp_path / ".env"
    values = {"POSTGRES_USER": "musicscope_v2", "POSTGRES_DB": "musicscope_v2", "POSTGRES_PORT": "55432"}
    old_url = module.database_url(values, "old-token")
    original = module.with_values(
        (ROOT / ".env.example").read_text(encoding="utf-8"),
        {"POSTGRES_PASSWORD": "old-token", "DATABASE_URL": old_url},
    )
    environment.write_text(original, encoding="utf-8")
    monkeypatch.setattr(module, "is_legacy_password", lambda _: True)
    changes: list[object] = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement):
            if not isinstance(statement, str):
                changes.append(statement)

        def fetchone(self):
            return ("musicscope_v2", "musicscope_v2")

    class Connection:
        def cursor(self):
            return Cursor()

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(psycopg, "connect", lambda *_args, **_kwargs: Connection())

    original_replace = module.os.replace

    def fail_replace(source, target):
        if target == environment:
            raise OSError("simulated atomic replacement failure")
        original_replace(source, target)

    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(RuntimeError, match="previous credential was restored"):
        module.rotate_legacy_database_password(environment)
    assert len(changes) == 2  # New role password, then rollback to the previous password.
    assert environment.read_text(encoding="utf-8") == original
    assert not list(tmp_path.glob(".env.*"))


def test_pending_rotation_recovers_after_role_change(tmp_path: Path, monkeypatch) -> None:
    import psycopg

    environment = tmp_path / ".env"
    values = {"POSTGRES_USER": "musicscope_v2", "POSTGRES_DB": "musicscope_v2", "POSTGRES_PORT": "55432"}
    old_url = module.database_url(values, "old-token")
    old_contents = module.with_values(
        (ROOT / ".env.example").read_text(encoding="utf-8"),
        {"POSTGRES_PASSWORD": "old-token", "DATABASE_URL": old_url},
    )
    environment.write_text(old_contents, encoding="utf-8")
    pending = tmp_path / ".env.rotation-pending"
    new_password = "a" * 64
    new_url = module.replace_url_password(old_url, "old-token", new_password, values)
    pending_contents = module.with_values(
        old_contents, {"POSTGRES_PASSWORD": new_password, "DATABASE_URL": new_url}
    )
    pending.write_text(pending_contents, encoding="utf-8")
    monkeypatch.setattr(module, "is_legacy_password", lambda password: password == "old-token")

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(psycopg, "connect", lambda *_args, **_kwargs: Connection())
    assert module.rotate_legacy_database_password(environment) is True
    assert environment.read_text(encoding="utf-8") == pending_contents
    assert not pending.exists()
