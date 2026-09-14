import base64
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.core.secrets import (
    ProviderSecretCipher,
    SecretConfigurationError,
    SecretDecryptionError,
)
from app.domain.models import MusicConnection, MusicConnectionSecret, User
from app.main import app


def encoded_key(byte: bytes = b"k") -> str:
    return base64.urlsafe_b64encode(byte * 32).decode()


def cipher(key: str | None = None) -> ProviderSecretCipher:
    return ProviderSecretCipher(
        Settings(
            _env_file=None,
            secret_encryption_key=encoded_key() if key is None else key,
            secret_encryption_key_version=7,
        )
    )


def test_session_payload_is_authenticated_encrypted_at_rest() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    provider_session = {"cookie": "provider-session-sentinel", "refresh_token": "private"}
    encrypted = cipher().encrypt(provider_session, context="connection:one")

    assert "provider-session-sentinel" not in encrypted
    assert json.loads(encrypted)["key_version"] == 7

    with Session(engine) as session:
        user = User()
        session.add(user)
        session.flush()
        connection = MusicConnection(user_id=user.id, provider="netease")
        session.add(connection)
        session.flush()
        session.add(
            MusicConnectionSecret(
                connection_id=connection.id,
                encrypted_session=encrypted,
                key_version=7,
            )
        )
        session.commit()
        stored = session.execute(text("SELECT encrypted_session FROM music_connection_secrets")).scalar_one()

    assert "provider-session-sentinel" not in stored
    assert cipher().decrypt(stored, context="connection:one") == provider_session


def test_missing_or_incorrect_encryption_configuration_fails_safely() -> None:
    with pytest.raises(SecretConfigurationError):
        ProviderSecretCipher(Settings(_env_file=None, secret_encryption_key=None))
    with pytest.raises(SecretConfigurationError):
        ProviderSecretCipher(Settings(_env_file=None, secret_encryption_key="not-base64"))

    encrypted = cipher().encrypt({"cookie": "private"}, context="connection:one")
    wrong_cipher = ProviderSecretCipher(
        Settings(
            _env_file=None,
            secret_encryption_key=encoded_key(b"z"),
            secret_encryption_key_version=7,
        )
    )
    with pytest.raises(SecretDecryptionError, match="could not be decrypted"):
        wrong_cipher.decrypt(encrypted, context="connection:one")


def test_plaintext_secret_and_secret_bearing_metadata_are_rejected() -> None:
    with pytest.raises(ValueError, match="encrypted envelope"):
        MusicConnectionSecret(connection_id=uuid4(), encrypted_session="provider-session=plaintext")
    with pytest.raises(ValueError, match="MusicConnectionSecret"):
        MusicConnection(user_id=uuid4(), metadata_json={"nested": {"access_token": "private"}})


def test_public_api_contract_cannot_serialize_secret_storage_fields() -> None:
    openapi = json.dumps(app.openapi())
    assert "MusicConnectionSecret" not in openapi
    assert "encrypted_session" not in openapi
    assert "secret_encryption_key" not in openapi
