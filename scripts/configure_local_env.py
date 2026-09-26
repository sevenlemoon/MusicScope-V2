from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import os
import secrets
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / ".env.example"
ENV = ROOT / ".env"
# Recognition only: the former documented password is not a new-install default.
LEGACY_PASSWORD_SHA256 = "0e283c01d8ecda577a149c14fcc4068c5735cefda2d0da104755fc6fc3f04a91"


def env_values(contents: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in contents.splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name in values:
            raise RuntimeError(f"Duplicate local environment setting: {name}")
        values[name] = value
    return values


def with_values(contents: str, replacements: dict[str, str]) -> str:
    seen: set[str] = set()
    lines: list[str] = []
    for line in contents.splitlines(keepends=True):
        name = line.split("=", 1)[0]
        if name in replacements and not line.lstrip().startswith("#"):
            lines.append(f"{name}={replacements[name]}\n")
            seen.add(name)
        else:
            lines.append(line)
    for name in replacements:
        if name not in seen:
            lines.append(f"{name}={replacements[name]}\n")
    return "".join(lines)


def prepared_file(path: Path, contents: str) -> Path:
    fd, name = tempfile.mkstemp(prefix=".env.", dir=path.parent, text=True)
    temporary = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return temporary


def database_url(values: dict[str, str], password: str) -> str:
    user = values.get("POSTGRES_USER", "musicscope_v2")
    database = values.get("POSTGRES_DB", "musicscope_v2")
    port = values.get("POSTGRES_PORT", "55432")
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise RuntimeError("Invalid local PostgreSQL port")
    return (
        f"postgresql+psycopg://{quote(user, safe='')}:{password}"
        f"@127.0.0.1:{port}/{quote(database, safe='')}"
    )


def bootstrap_environment(
    env: Path = ENV, example: Path = ENV_EXAMPLE, *, allow_existing: bool = False
) -> bool:
    exists = env.exists()
    if exists and not allow_existing:
        raise RuntimeError("Refusing to overwrite an existing local environment")
    contents = env.read_text(encoding="utf-8") if exists else example.read_text(encoding="utf-8")
    values = env_values(contents)
    replacements: dict[str, str] = {}
    password = values.get("POSTGRES_PASSWORD", "")
    if not password:
        if values.get("DATABASE_URL"):
            raise RuntimeError("Database URL exists but the local PostgreSQL password is missing")
        password = secrets.token_hex(32)
        replacements["POSTGRES_PASSWORD"] = password
    if not values.get("DATABASE_URL"):
        replacements["DATABASE_URL"] = database_url(values, password)
    if not values.get("SECRET_ENCRYPTION_KEY"):
        replacements["SECRET_ENCRYPTION_KEY"] = base64.urlsafe_b64encode(
            secrets.token_bytes(32)
        ).decode("ascii")
    if not replacements:
        return False
    candidate = prepared_file(env, with_values(contents, replacements))
    try:
        os.replace(candidate, env)
    finally:
        candidate.unlink(missing_ok=True)
    return True


def is_legacy_password(password: str) -> bool:
    return hmac.compare_digest(hashlib.sha256(password.encode("utf-8")).hexdigest(), LEGACY_PASSWORD_SHA256)


def replace_url_password(url: str, old_password: str, new_password: str, values: dict[str, str]) -> str:
    parts = urlsplit(url)
    if (
        parts.scheme != "postgresql+psycopg"
        or parts.hostname not in {"localhost", "127.0.0.1"}
        or parts.username != values.get("POSTGRES_USER")
        or parts.password != old_password
        or parts.path.lstrip("/") != values.get("POSTGRES_DB")
        or parts.port != int(values.get("POSTGRES_PORT", "55432"))
        or parts.fragment
    ):
        raise RuntimeError("Local database URL does not match the configured PostgreSQL role and port")
    netloc = f"{quote(parts.username, safe='')}:{new_password}@{parts.hostname}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))


def rotate_legacy_database_password(env: Path = ENV) -> bool:
    import psycopg
    from psycopg import sql

    contents = env.read_text(encoding="utf-8")
    values = env_values(contents)
    old_password = values.get("POSTGRES_PASSWORD", "")
    if not is_legacy_password(old_password):
        return False
    old_url = values.get("DATABASE_URL", "")
    pending = env.with_name(f"{env.name}.rotation-pending")
    if pending.exists():
        pending_contents = pending.read_text(encoding="utf-8")
        pending_values = env_values(pending_contents)
        pending_password = pending_values.get("POSTGRES_PASSWORD", "")
        pending_url = pending_values.get("DATABASE_URL", "")
        if (
            len(pending_password) != 64
            or is_legacy_password(pending_password)
            or pending_contents != with_values(
                contents, {"POSTGRES_PASSWORD": pending_password, "DATABASE_URL": pending_url}
            )
            or pending_url != replace_url_password(old_url, old_password, pending_password, values)
        ):
            raise RuntimeError("Pending local database rotation needs manual review")
        try:
            with psycopg.connect(
                pending_url.replace("postgresql+psycopg://", "postgresql://", 1), connect_timeout=5
            ):
                pass
        except psycopg.OperationalError:
            try:
                with psycopg.connect(
                    old_url.replace("postgresql+psycopg://", "postgresql://", 1), connect_timeout=5
                ):
                    pass
            except psycopg.OperationalError as exc:
                raise RuntimeError(
                    "Neither local database credential works; manual recovery is required"
                ) from exc
            pending.unlink()
        else:
            os.replace(pending, env)
            return True
    new_password = secrets.token_hex(32)
    new_url = replace_url_password(old_url, old_password, new_password, values)
    candidate = prepared_file(
        pending,
        with_values(contents, {"POSTGRES_PASSWORD": new_password, "DATABASE_URL": new_url}),
    )
    try:
        os.replace(candidate, pending)
    finally:
        candidate.unlink(missing_ok=True)
    connection = None
    changed = False
    try:
        connection = psycopg.connect(
            old_url.replace("postgresql+psycopg://", "postgresql://", 1), autocommit=True
        )
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_user, current_database()")
            if cursor.fetchone() != (values["POSTGRES_USER"], values["POSTGRES_DB"]):
                raise RuntimeError("Connected PostgreSQL identity does not match local configuration")
            cursor.execute(
                sql.SQL("ALTER ROLE {} WITH PASSWORD {}").format(
                    sql.Identifier(values["POSTGRES_USER"]), sql.Literal(new_password)
                )
            )
            changed = True
        with psycopg.connect(new_url.replace("postgresql+psycopg://", "postgresql://", 1), connect_timeout=5):
            pass
        os.replace(pending, env)
        changed = False
        return True
    except BaseException as exc:
        if changed and connection is not None:
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        sql.SQL("ALTER ROLE {} WITH PASSWORD {}").format(
                            sql.Identifier(values["POSTGRES_USER"]), sql.Literal(old_password)
                        )
                    )
                changed = False
            except Exception as recovery_error:
                raise RuntimeError(
                    "Database password rotation needs local recovery; "
                    "the 0600 pending environment was preserved"
                ) from recovery_error
        if connection is None:
            raise RuntimeError("Database password rotation failed before changing the role") from exc
        raise RuntimeError("Database password rotation failed; the previous credential was restored") from exc
    finally:
        if connection is not None:
            connection.close()
        if not changed:
            pending.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure the ignored local MusicScope environment")
    parser.add_argument("--allow-existing-empty", action="store_true")
    parser.add_argument("--rotate-legacy-db-password", action="store_true")
    parser.add_argument("--needs-db-rotation", action="store_true")
    args = parser.parse_args()
    try:
        if args.needs_db_rotation:
            values = env_values(ENV.read_text(encoding="utf-8"))
            sys.exit(0 if is_legacy_password(values.get("POSTGRES_PASSWORD", "")) else 1)
        if args.rotate_legacy_db_password:
            changed = rotate_legacy_database_password()
            print("database_credential=rotated" if changed else "database_credential=unchanged")
        else:
            changed = bootstrap_environment(allow_existing=args.allow_existing_empty)
            print("local_environment=initialized" if changed else "local_environment=unchanged")
    except Exception as exc:
        raise SystemExit(str(exc)) from None


if __name__ == "__main__":
    main()
