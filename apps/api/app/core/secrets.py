import base64
import binascii
import json
import os
from collections.abc import Mapping
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings, get_settings

ALGORITHM = "AES-256-GCM"
ENVELOPE_VERSION = 1
NONCE_BYTES = 12
KEY_BYTES = 32


class SecretConfigurationError(RuntimeError):
    """Raised when encrypted storage is requested without a valid server key."""


class SecretDecryptionError(RuntimeError):
    """Raised without disclosing whether ciphertext, context, or key was incorrect."""


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SecretDecryptionError("Encrypted provider session could not be decrypted.") from exc


def _load_key(settings: Settings) -> bytes:
    raw_key = settings.secret_encryption_key
    if not raw_key:
        raise SecretConfigurationError(
            "SECRET_ENCRYPTION_KEY must be configured before provider sessions can be stored."
        )
    try:
        key = _decode(raw_key)
    except SecretDecryptionError as exc:
        raise SecretConfigurationError("SECRET_ENCRYPTION_KEY must be valid URL-safe base64.") from exc
    if len(key) != KEY_BYTES:
        raise SecretConfigurationError("SECRET_ENCRYPTION_KEY must encode exactly 32 bytes.")
    return key


class ProviderSecretCipher:
    """Versioned authenticated encryption for server-only provider session material."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._key = _load_key(self._settings)

    @property
    def key_version(self) -> int:
        return self._settings.secret_encryption_key_version

    def encrypt(self, payload: Mapping[str, Any], *, context: str) -> str:
        plaintext = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        nonce = os.urandom(NONCE_BYTES)
        ciphertext = AESGCM(self._key).encrypt(nonce, plaintext, context.encode())
        envelope = {
            "algorithm": ALGORITHM,
            "ciphertext": _encode(ciphertext),
            "key_version": self._settings.secret_encryption_key_version,
            "nonce": _encode(nonce),
            "version": ENVELOPE_VERSION,
        }
        return json.dumps(envelope, sort_keys=True, separators=(",", ":"))

    def decrypt(self, envelope_json: str, *, context: str) -> dict[str, Any]:
        try:
            envelope = json.loads(envelope_json)
            if (
                envelope["algorithm"] != ALGORITHM
                or envelope["version"] != ENVELOPE_VERSION
                or envelope["key_version"] != self._settings.secret_encryption_key_version
            ):
                raise SecretDecryptionError("Encrypted provider session uses an unsupported envelope.")
            plaintext = AESGCM(self._key).decrypt(
                _decode(envelope["nonce"]),
                _decode(envelope["ciphertext"]),
                context.encode(),
            )
            result = json.loads(plaintext)
            if not isinstance(result, dict):
                raise SecretDecryptionError("Encrypted provider session has an invalid payload.")
            return result
        except SecretDecryptionError:
            raise
        except (InvalidTag, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise SecretDecryptionError("Encrypted provider session could not be decrypted.") from exc
