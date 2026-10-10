from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.secrets import ProviderSecretCipher, SecretDecryptionError
from app.domain.enums import ConnectionStatus, ProviderName
from app.domain.models import (
    MusicConnection,
    MusicConnectionChallenge,
    MusicConnectionSecret,
    User,
)
from app.providers.errors import ProviderAuthenticationExpired
from app.providers.netease import NetEaseProvider
from app.providers.types import AuthChallenge

ProviderFactory = Callable[[str | None], NetEaseProvider]


def default_provider_factory(session_cookie: str | None = None) -> NetEaseProvider:
    return NetEaseProvider(session_cookie=session_cookie)


class MusicConnectionService:
    def __init__(
        self,
        session: Session,
        *,
        provider_factory: ProviderFactory = default_provider_factory,
        cipher: ProviderSecretCipher | None = None,
    ) -> None:
        self.session = session
        self.provider_factory = provider_factory
        self.cipher = cipher

    def local_user(self) -> User:
        user = self.session.scalar(select(User).order_by(User.created_at, User.id).limit(1))
        if user is None:
            user = User(display_name="MusicScope listener")
            self.session.add(user)
            self.session.flush()
        return user

    async def create_netease_challenge(self) -> tuple[MusicConnectionChallenge, AuthChallenge]:
        user = self.local_user()
        provider = self.provider_factory(None)
        active = list(
            self.session.scalars(
                select(MusicConnectionChallenge).where(
                    MusicConnectionChallenge.user_id == user.id,
                    MusicConnectionChallenge.provider == ProviderName.NETEASE.value,
                    MusicConnectionChallenge.status.in_(
                        [
                            ConnectionStatus.CREATING_QR.value,
                            ConnectionStatus.WAITING_SCAN.value,
                            ConnectionStatus.WAITING_CONFIRM.value,
                        ]
                    ),
                )
            )
        )
        for challenge in active:
            challenge.status = ConnectionStatus.EXPIRED.value
            try:
                await provider.cancel_auth_challenge(str(challenge.id))
            except Exception:
                pass

        generation = (
            self.session.scalar(
                select(func.max(MusicConnectionChallenge.generation)).where(
                    MusicConnectionChallenge.user_id == user.id,
                    MusicConnectionChallenge.provider == ProviderName.NETEASE.value,
                )
            )
            or 0
        ) + 1
        auth = await provider.create_auth_challenge()
        challenge = MusicConnectionChallenge(
            id=UUID(auth.public_id),
            user_id=user.id,
            provider=ProviderName.NETEASE.value,
            generation=generation,
            status=auth.state.value,
            expires_at=auth.expires_at,
        )
        self.session.add(challenge)
        self.session.flush()
        return challenge, auth

    async def poll_netease_challenge(
        self, challenge_id: str
    ) -> tuple[MusicConnectionChallenge, MusicConnection | None]:
        challenge = self.session.get(MusicConnectionChallenge, UUID(challenge_id))
        if challenge is None or challenge.provider != ProviderName.NETEASE.value:
            raise LookupError("QR challenge not found.")
        latest_generation = self.session.scalar(
            select(func.max(MusicConnectionChallenge.generation)).where(
                MusicConnectionChallenge.user_id == challenge.user_id,
                MusicConnectionChallenge.provider == challenge.provider,
            )
        )
        if challenge.generation != latest_generation:
            challenge.status = ConnectionStatus.EXPIRED.value
            return challenge, None
        if challenge.status in {
            ConnectionStatus.CONNECTED.value,
            ConnectionStatus.EXPIRED.value,
            ConnectionStatus.FAILED.value,
        }:
            return challenge, None
        # SQLite drops timezone information even for DateTime(timezone=True)
        # columns. Treat a naive value read from the database as UTC before
        # comparing it with the timezone-aware clock.
        expires_at = challenge.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at <= datetime.now(UTC):
            challenge.status = ConnectionStatus.EXPIRED.value
            return challenge, None

        unauthenticated_provider = self.provider_factory(None)
        result = await unauthenticated_provider.poll_auth_challenge(str(challenge.id))
        challenge.status = result.state.value
        if result.state != ConnectionStatus.CONNECTED:
            return challenge, None
        if not result.session_material or not result.session_material.get("cookie"):
            challenge.status = ConnectionStatus.FAILED.value
            challenge.failure_code = "provider_session_missing"
            return challenge, None

        latest_generation = self.session.scalar(
            select(func.max(MusicConnectionChallenge.generation)).where(
                MusicConnectionChallenge.user_id == challenge.user_id,
                MusicConnectionChallenge.provider == challenge.provider,
            )
        )
        if challenge.generation != latest_generation:
            challenge.status = ConnectionStatus.EXPIRED.value
            return challenge, None

        cookie = result.session_material["cookie"]
        authenticated_provider = self.provider_factory(cookie)
        profile = await authenticated_provider.get_profile()
        provider_user_id = str(profile["provider_user_id"])
        connection = self.session.scalar(
            select(MusicConnection).where(
                MusicConnection.user_id == challenge.user_id,
                MusicConnection.provider == ProviderName.NETEASE.value,
                MusicConnection.provider_user_id == provider_user_id,
            )
        )
        if connection is None:
            connection = MusicConnection(
                user_id=challenge.user_id,
                provider=ProviderName.NETEASE.value,
                provider_user_id=provider_user_id,
            )
            self.session.add(connection)
            self.session.flush()
        connection.status = ConnectionStatus.CONNECTED.value
        connection.connected_at = datetime.now(UTC)
        connection.metadata_json = {
            "nickname": profile.get("nickname"),
            "avatar_url": profile.get("avatar_url"),
        }

        cipher = self.cipher or ProviderSecretCipher(get_settings())
        encrypted = cipher.encrypt({"cookie": cookie}, context=f"music-connection:{connection.id}")
        secret = self.session.scalar(
            select(MusicConnectionSecret).where(MusicConnectionSecret.connection_id == connection.id)
        )
        if secret is None:
            secret = MusicConnectionSecret(
                connection_id=connection.id,
                encrypted_session=encrypted,
                key_version=cipher.key_version,
            )
            self.session.add(secret)
        else:
            secret.encrypted_session = encrypted
            secret.key_version = cipher.key_version
        challenge.status = ConnectionStatus.CONNECTED.value
        self.session.flush()
        return challenge, connection

    def decrypt_session(self, connection: MusicConnection) -> str:
        secret = self.session.scalar(
            select(MusicConnectionSecret).where(MusicConnectionSecret.connection_id == connection.id)
        )
        if secret is None:
            raise ProviderAuthenticationExpired("Provider session is unavailable.")
        cipher = self.cipher or ProviderSecretCipher(get_settings())
        try:
            payload = cipher.decrypt(secret.encrypted_session, context=f"music-connection:{connection.id}")
        except SecretDecryptionError as exc:
            connection.status = ConnectionStatus.FAILED.value
            raise ProviderAuthenticationExpired("Stored provider session is invalid.") from exc
        cookie = payload.get("cookie")
        if not isinstance(cookie, str) or not cookie:
            connection.status = ConnectionStatus.FAILED.value
            raise ProviderAuthenticationExpired("Stored provider session is invalid.")
        return cookie

    async def rehydrate(self, connection: MusicConnection) -> dict[str, object]:
        provider = self.provider_factory(self.decrypt_session(connection))
        try:
            profile = await provider.get_profile()
        except ProviderAuthenticationExpired:
            connection.status = ConnectionStatus.EXPIRED.value
            raise
        connection.status = ConnectionStatus.CONNECTED.value
        connection.metadata_json = {
            "nickname": profile.get("nickname"),
            "avatar_url": profile.get("avatar_url"),
        }
        return profile

    def disconnect(self, connection: MusicConnection) -> None:
        secret = self.session.scalar(
            select(MusicConnectionSecret).where(MusicConnectionSecret.connection_id == connection.id)
        )
        if secret is not None:
            self.session.delete(secret)
        connection.status = ConnectionStatus.DISCONNECTED.value
        self.session.flush()
