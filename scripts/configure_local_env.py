from __future__ import annotations

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
    if ENV.exists():
        raise SystemExit("Refusing to overwrite an existing .env")

    example = ENV_EXAMPLE.read_text(encoding="utf-8")
    if f"{KEY_NAME}=\n" not in example:
        raise SystemExit("Expected an empty encryption-key placeholder in .env.example")

    encoded_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    if len(base64.urlsafe_b64decode(encoded_key.encode("ascii"))) != 32:
        raise SystemExit("Generated encryption key failed validation")

    configured = example.replace(f"{KEY_NAME}=\n", f"{KEY_NAME}={encoded_key}\n", 1)
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
