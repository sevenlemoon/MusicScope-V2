from __future__ import annotations

import argparse
import base64
import os
import secrets
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / ".env.example"
ENV = ROOT / ".env"
KEY_NAME = "SECRET_ENCRYPTION_KEY"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create or complete the ignored local MusicScope environment."
    )
    parser.add_argument(
        "--allow-existing-empty",
        action="store_true",
        help="Fill an empty key placeholder in an existing .env without changing other values.",
    )
    args = parser.parse_args()

    if ENV.exists():
        existing = ENV.read_text(encoding="utf-8")
        key_lines = [line for line in existing.splitlines() if line.startswith(f"{KEY_NAME}=")]
        if key_lines and key_lines[0].split("=", 1)[1].strip():
            print("local_encryption_key=already_configured")
            return
        if not args.allow_existing_empty:
            raise SystemExit("Refusing to overwrite an existing .env")
        example = existing
    else:
        example = ENV_EXAMPLE.read_text(encoding="utf-8")

    if f"{KEY_NAME}=\n" not in example and not any(
        line.startswith(f"{KEY_NAME}=") and not line.split("=", 1)[1].strip()
        for line in example.splitlines()
    ):
        raise SystemExit("Expected an empty encryption-key placeholder in the local environment")

    encoded_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    if len(base64.urlsafe_b64decode(encoded_key.encode("ascii"))) != 32:
        raise SystemExit("Generated encryption key failed validation")

    configured = example.replace(f"{KEY_NAME}=\n", f"{KEY_NAME}={encoded_key}\n", 1)
    if configured == example:
        lines = example.splitlines(keepends=True)
        configured = "".join(
            f"{KEY_NAME}={encoded_key}\n" if line.startswith(f"{KEY_NAME}=") else line for line in lines
        )
    fd, temporary_name = tempfile.mkstemp(prefix=".env.", dir=ROOT, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as temporary_file:
            temporary_file.write(configured)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_name, ENV)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise

    print("local_encryption_key=configured")


if __name__ == "__main__":
    main()
