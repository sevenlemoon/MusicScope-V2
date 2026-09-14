import base64
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.core.secrets import ProviderSecretCipher
from app.domain.enums import ConnectionStatus
from app.domain.models import MusicConnectionSecret
from app.providers.errors import ProviderAuthenticationExpired
from app.providers.types import AuthChallenge, AuthPollResult
from app.services.music_connections import MusicConnectionService


def make_cipher() -> ProviderSecretCipher:
    key = base64.urlsafe_b64encode(b"r" * 32).decode()
    return ProviderSecretCipher(
        Settings(_env_file=None, secret_encryption_key=key, secret_encryption_key_version=3)
    )


class FakeProvider:
    def __init__(self, state: ConnectionStatus = ConnectionStatus.WAITING_SCAN) -> None:
        self.state = state
        self.created: list[str] = []
        self.cancelled: list[str] = []
        self.session_cookie: str | None = None
        self.expired = False

    async def create_auth_challenge(self) -> AuthChallenge:
        public_id = str(uuid4())
        self.created.append(public_id)
        return AuthChallenge(
            public_id=public_id,
            state=ConnectionStatus.WAITING_SCAN,
            qr_content="https://music.163.com/login?codekey=safe",
            qr_image_data_url="data:image/png;base64,c2FmZQ==",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )

    async def cancel_auth_challenge(self, challenge_id: str) -> None:
        self.cancelled.append(challenge_id)

    async def poll_auth_challenge(self, challenge_id: str) -> AuthPollResult:
        del challenge_id
        return AuthPollResult(
            state=self.state,
            session_material={"cookie": "provider-session-sentinel"}
            if self.state is ConnectionStatus.CONNECTED
            else None,
        )

    async def get_profile(self) -> dict[str, object]:
        if self.expired:
            raise ProviderAuthenticationExpired("expired")
        return {
            "provider_user_id": "98765",
            "nickname": "Real listener",
            "avatar_url": "https://p1.music.126.net/avatar.jpg",
        }


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def test_qr_creation_replacement_and_stale_poll_cancellation(db: Session) -> None:
    provider = FakeProvider()
    service = MusicConnectionService(db, provider_factory=lambda cookie: provider, cipher=make_cipher())
    first, _ = __import__("asyncio").run(service.create_netease_challenge())
    second, _ = __import__("asyncio").run(service.create_netease_challenge())
    stale, connection = __import__("asyncio").run(service.poll_netease_challenge(str(first.id)))

    assert first.id != second.id
    assert str(first.id) in provider.cancelled
    assert stale.status == ConnectionStatus.EXPIRED.value
    assert connection is None


def test_qr_expiration_does_not_poll_provider(db: Session) -> None:
    provider = FakeProvider()
    service = MusicConnectionService(db, provider_factory=lambda cookie: provider, cipher=make_cipher())
    challenge, _ = __import__("asyncio").run(service.create_netease_challenge())
    challenge.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    result, _ = __import__("asyncio").run(service.poll_netease_challenge(str(challenge.id)))
    assert result.status == ConnectionStatus.EXPIRED.value


def test_803_persists_encrypted_session_and_rehydrates(db: Session) -> None:
    provider = FakeProvider(ConnectionStatus.CONNECTED)
    service = MusicConnectionService(db, provider_factory=lambda cookie: provider, cipher=make_cipher())
    challenge, _ = __import__("asyncio").run(service.create_netease_challenge())
    _, connection = __import__("asyncio").run(service.poll_netease_challenge(str(challenge.id)))
    assert connection is not None
    secret = db.scalar(
        select(MusicConnectionSecret).where(MusicConnectionSecret.connection_id == connection.id)
    )
    assert secret is not None
    assert "provider-session-sentinel" not in secret.encrypted_session
    profile = __import__("asyncio").run(service.rehydrate(connection))
    assert profile["provider_user_id"] == "98765"
    assert connection.status == ConnectionStatus.CONNECTED.value


def test_expired_session_and_disconnect_preserve_connection_row(db: Session) -> None:
    provider = FakeProvider(ConnectionStatus.CONNECTED)
    service = MusicConnectionService(db, provider_factory=lambda cookie: provider, cipher=make_cipher())
    challenge, _ = __import__("asyncio").run(service.create_netease_challenge())
    _, connection = __import__("asyncio").run(service.poll_netease_challenge(str(challenge.id)))
    assert connection is not None
    provider.expired = True
    with pytest.raises(ProviderAuthenticationExpired):
        __import__("asyncio").run(service.rehydrate(connection))
    assert connection.status == ConnectionStatus.EXPIRED.value

    service.disconnect(connection)
    assert connection.status == ConnectionStatus.DISCONNECTED.value
    assert (
        db.scalar(
            select(func.count())
            .select_from(MusicConnectionSecret)
            .where(MusicConnectionSecret.connection_id == connection.id)
        )
        == 0
    )
