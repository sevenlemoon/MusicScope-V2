import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes import catalog
from app.core.database import Base
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import MusicConnection, Track, User
from app.providers.errors import ProviderAuthenticationExpired, ProviderTemporarilyUnavailable
from app.providers.netease import NetEaseProvider
from app.services.identity_resolution import bind_external_identity
from app.services.lyrics import TrackLyricsService, normalize_lyrics
from app.services.music_connections import MusicConnectionService


@pytest.mark.parametrize(('payload', 'kind', 'precision'), [
    ({'lrc': {'lyric': '[00:01.23]Real line'}}, 'synced', 'line'),
    ({'lrc': {'lyric': 'Real untimed line'}}, 'plain', 'none'),
    ({'nolyric': True}, 'instrumental', 'none'),
    ({'lrc': {'lyric': '[99:00.00]纯音乐，请欣赏'}}, 'instrumental', 'none'),
    ({'uncollected': True}, 'none', 'none'),
    ({'lrc': {'lyric': None}}, 'none', 'none'),
])
def test_lyrics_normalization_does_not_invent_timing(payload, kind, precision):
    result = normalize_lyrics(uuid4(), payload)
    assert result.kind == kind
    assert result.precision == precision
    if kind == 'synced':
        assert result.original == payload['lrc']['lyric']


def test_lyrics_reads_internal_identity_using_the_existing_session(monkeypatch):
    engine = create_engine('sqlite+pysqlite:///:memory:')
    Base.metadata.create_all(engine)
    provider_call = AsyncMock(return_value={'lrc': {'lyric': '[00:03.50]Original'},
                                           'tlyric': {'lyric': '[00:03.50]Translation'}})
    monkeypatch.setattr(NetEaseProvider, 'get_lyrics', provider_call)
    monkeypatch.setattr(MusicConnectionService, 'decrypt_session', lambda *_: 'test-session-placeholder')
    with Session(engine) as db:
        track, local, user = Track(title='Real track'), Track(title='Local'), User()
        db.add_all([track, local, user])
        db.flush()
        assert asyncio.run(TrackLyricsService(db).get(local.id)).kind == 'none'
        bind_external_identity(db, provider='netease', entity_type=EntityType.TRACK,
                               provider_id='12345', entity=track)
        with pytest.raises(PermissionError):
            asyncio.run(TrackLyricsService(db).get(track.id))
        db.add(MusicConnection(user_id=user.id, provider='netease',
                               provider_user_id='listener', status=ConnectionStatus.CONNECTED.value))
        db.flush()
        result = asyncio.run(TrackLyricsService(db).get(track.id))
        provider_call.assert_awaited_once_with('12345')
        assert result.track_id == str(track.id)
        assert result.translated == '[00:03.50]Translation'
        with pytest.raises(LookupError):
            asyncio.run(TrackLyricsService(db).get(uuid4()))
    engine.dispose()


def test_provider_lyrics_calls_the_authenticated_read_only_route():
    provider = NetEaseProvider(session_cookie='test-placeholder')
    provider._post = AsyncMock(return_value={'nolyric': True})
    assert asyncio.run(provider.get_lyrics('123')) == {'nolyric': True}
    provider._post.assert_awaited_once_with('lyrics', '/v1/song/lyrics',
                                          {'session_cookie': 'test-placeholder', 'id': '123'})


@pytest.mark.parametrize(('error', 'status'), [
    (LookupError('private details'), 404), (PermissionError('private details'), 409),
    (ProviderAuthenticationExpired('private details'), 401),
    (ProviderTemporarilyUnavailable('private details'), 503),
])
def test_lyrics_errors_have_safe_status_and_never_expose_provider_details(monkeypatch, error, status):
    monkeypatch.setattr(TrackLyricsService, 'get', AsyncMock(side_effect=error))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(catalog.track_lyrics(uuid4(), Response(), None))
    assert caught.value.status_code == status
    assert 'private details' not in caught.value.detail


def test_provider_lyric_failure_code_is_not_reported_as_missing_lyrics():
    provider = NetEaseProvider(session_cookie='test-placeholder')
    provider._post = AsyncMock(return_value={'code': 503})
    with pytest.raises(ProviderTemporarilyUnavailable):
        asyncio.run(provider.get_lyrics('123'))
