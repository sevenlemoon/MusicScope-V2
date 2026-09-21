from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from difflib import SequenceMatcher
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.domain.models import (
    Artist,
    ArtistSearchAlias,
    ConcertEvent,
    ConcertEventSource,
    ConcertPerformer,
    LiveRecommendation,
    LiveSearchCache,
    RecommendationProfile,
    RecommendationProfileArtist,
    User,
    UserLivePreference,
)
from app.providers.concert import (
    ConcertCapability,
    ConcertProvider,
    ProviderConcertEvent,
    is_safe_public_url,
    normalize_artist_name,
)
from app.services.concert_aggregator import (
    ConcertAggregator,
    LiveResultStatus,
    ProviderSearchResult,
)


@dataclass(frozen=True)
class LiveSearchResult:
    query: str
    status: str
    events: tuple[ConcertEvent, ...]
    matches: tuple[dict[str, str | None], ...]
    provider_states: dict[str, str]
    provider_results: tuple[ProviderSearchResult, ...]
    cache_state: str
    generated_at: datetime


@dataclass(frozen=True)
class LiveRefreshResult:
    status: str
    seed_count: int
    matched_artists: int
    event_count: int
    generated_at: datetime | None


class LiveConcertService:
    provider_priority = {
        "ticketmaster": 0,
        "asiaworld_expo": 10,
        "showstart": 20,
        "kktix": 30,
        "maoyan": 40,
    }

    def __init__(
        self,
        session: Session,
        aggregator: ConcertAggregator,
        *,
        cache_ttl_hours: int = 6,
        search_cache_minutes: int = 30,
        seed_budget: int = 12,
    ) -> None:
        self.session = session
        self.aggregator = aggregator
        self.cache_ttl = timedelta(hours=max(1, cache_ttl_hours))
        self.search_ttl = timedelta(minutes=max(5, search_cache_minutes))
        self.seed_budget = max(1, min(seed_budget, 30))

    async def search(
        self,
        query: str,
        *,
        user: User,
        country: str | None = None,
        city: str | None = None,
        date_filter: str = "all",
    ) -> LiveSearchResult:
        now = datetime.now(UTC)
        clean_query = " ".join(query.split())[:300]
        effective_query = self._resolve_alias(clean_query, user)
        cache_key = self._cache_key(effective_query, country, city)
        cached = self.session.scalar(
            select(LiveSearchCache).where(LiveSearchCache.cache_key == cache_key)
        )
        if cached is not None and self._as_utc(cached.expires_at) > now:
            events = self._events_by_ids(cached.event_ids, date_filter=date_filter, today=now.date())
            return LiveSearchResult(
                query=clean_query,
                status=cached.status,
                events=tuple(events),
                matches=tuple(cached.match_payload.get("matches", [])),
                provider_states=cached.provider_states,
                provider_results=tuple(
                    ProviderSearchResult(**value)
                    for value in cached.match_payload.get("provider_results", [])
                ),
                cache_state="fresh",
                generated_at=cached.generated_at,
            )

        result = await self.aggregator.search_artist(
            effective_query, country=country, city=city
        )
        if (
            cached is not None
            and cached.event_ids
            and result.status
            in {
                LiveResultStatus.PARTIAL_RESULTS,
                LiveResultStatus.PROVIDER_NOT_CONFIGURED,
                LiveResultStatus.PROVIDER_UNAVAILABLE,
                LiveResultStatus.PROVIDER_RATE_LIMITED,
            }
            and not result.events
        ):
            events = self._events_by_ids(cached.event_ids, date_filter=date_filter, today=now.date())
            return LiveSearchResult(
                query=clean_query,
                status=LiveResultStatus.PARTIAL_RESULTS.value,
                events=tuple(events),
                matches=tuple(cached.match_payload.get("matches", [])),
                provider_states=result.provider_states,
                provider_results=result.provider_results,
                cache_state="stale",
                generated_at=cached.generated_at,
            )
        event_ids = self.materialize(result.events)
        generated_at = datetime.now(UTC)
        values = {
            "query": clean_query,
            "status": result.status.value,
            "match_payload": {
                "matches": list(result.matches),
                "provider_results": [
                    {
                        "provider": value.provider,
                        "status": value.status,
                        "result_count": value.result_count,
                        "latency_ms": value.latency_ms,
                        "match_state": value.match_state,
                    }
                    for value in result.provider_results
                ],
                "effective_query": effective_query if effective_query != clean_query else None,
            },
            "provider_states": result.provider_states,
            "event_ids": [str(event_id) for event_id in event_ids],
            "generated_at": generated_at,
            "expires_at": generated_at + self.search_ttl,
        }
        if cached is None:
            cached = LiveSearchCache(cache_key=cache_key, **values)
            self.session.add(cached)
        else:
            for key, value in values.items():
                setattr(cached, key, value)
        self.session.flush()
        events = self._events_by_ids(values["event_ids"], date_filter=date_filter, today=now.date())
        return LiveSearchResult(
            query=clean_query,
            status=result.status.value,
            events=tuple(events),
            matches=result.matches,
            provider_states=result.provider_states,
            provider_results=result.provider_results,
            cache_state="miss",
            generated_at=generated_at,
        )

    def materialize(self, provider_events: tuple[ProviderConcertEvent, ...]) -> list[UUID]:
        event_ids: list[UUID] = []
        for provider_event in provider_events:
            if not is_safe_public_url(provider_event.event_url):
                continue
            source = self.session.scalar(
                select(ConcertEventSource).where(
                    ConcertEventSource.provider == provider_event.provider,
                    ConcertEventSource.provider_event_id == provider_event.provider_event_id,
                )
            )
            if source is not None:
                event = self.session.get(ConcertEvent, source.event_id)
                if event is None:
                    continue
                self._refresh_source(source, provider_event)
            else:
                event = self._deduplication_candidate(provider_event)
                if event is None:
                    event = self._new_event(provider_event)
                    self.session.add(event)
                    self.session.flush()
                source = ConcertEventSource(
                    event_id=event.id,
                    provider=provider_event.provider,
                    provider_event_id=provider_event.provider_event_id,
                    event_url=provider_event.event_url,
                    ticket_url=provider_event.ticket_url,
                    status=provider_event.status,
                    observed_at=provider_event.observed_at or datetime.now(UTC),
                    last_refreshed_at=datetime.now(UTC),
                    source_payload=self._source_payload(provider_event),
                )
                self.session.add(source)
            if self._should_refresh_canonical(event, provider_event.provider):
                self._refresh_event(event, provider_event)
                event.source_metadata = {
                    **event.source_metadata,
                    "canonical_provider": provider_event.provider,
                }
            self._merge_performers(event, provider_event)
            self._persist_verified_aliases(provider_event)
            event_ids.append(event.id)
        self.session.flush()
        return list(dict.fromkeys(event_ids))

    def _persist_verified_aliases(self, value: ProviderConcertEvent) -> None:
        evidence = value.metadata.get("verified_artist_identity")
        if not isinstance(evidence, dict):
            return
        canonical_name = evidence.get("canonical_name")
        aliases = evidence.get("aliases")
        source = evidence.get("source")
        evidence_urls = evidence.get("evidence_urls")
        if (
            not isinstance(canonical_name, str)
            or not canonical_name.strip()
            or not isinstance(aliases, list)
            or not isinstance(source, str)
            or not source.strip()
            or not isinstance(evidence_urls, list)
            or not evidence_urls
            or not all(
                isinstance(url, str) and is_safe_public_url(url) for url in evidence_urls
            )
        ):
            return
        artist = next(
            (
                candidate
                for candidate in self.session.scalars(select(Artist))
                if normalize_artist_name(candidate.name) == normalize_artist_name(canonical_name)
            ),
            None,
        )
        for alias in aliases:
            if not isinstance(alias, str) or not alias.strip():
                continue
            normalized = normalize_artist_name(alias)
            if not normalized or normalized == normalize_artist_name(canonical_name):
                continue
            existing = self.session.scalar(
                select(ArtistSearchAlias).where(
                    ArtistSearchAlias.user_id.is_(None),
                    ArtistSearchAlias.normalized_alias == normalized,
                    ArtistSearchAlias.canonical_name == canonical_name,
                )
            )
            if existing is None:
                self.session.add(
                    ArtistSearchAlias(
                        user_id=None,
                        artist_id=artist.id if artist else None,
                        alias=alias,
                        normalized_alias=normalized,
                        canonical_name=canonical_name,
                        source=source[:40],
                        verified=True,
                    )
                )

    def cached_feed(
        self,
        user: User,
        *,
        date_filter: str = "all",
        country: str | None = None,
        city: str | None = None,
        limit: int = 30,
    ) -> list[tuple[LiveRecommendation, ConcertEvent]]:
        today = datetime.now(UTC).date()
        statement = (
            select(LiveRecommendation, ConcertEvent)
            .join(ConcertEvent, ConcertEvent.id == LiveRecommendation.event_id)
            .where(LiveRecommendation.user_id == user.id, ConcertEvent.start_date >= today)
            .order_by(LiveRecommendation.rank, ConcertEvent.start_date, ConcertEvent.id)
            .limit(min(max(limit, 1), 60))
        )
        if country:
            statement = statement.where(ConcertEvent.country == country)
        if city:
            statement = statement.where(ConcertEvent.city == city)
        rows = list(self.session.execute(statement))
        return [row for row in rows if self._date_matches(row[1].start_date, date_filter, today)]

    async def refresh_for_user(self, user: User) -> LiveRefreshResult:
        profile = self.session.scalar(
            select(RecommendationProfile).where(
                RecommendationProfile.user_id == user.id,
                RecommendationProfile.profile_type == "library_taste",
            )
        )
        if profile is None:
            return LiveRefreshResult("PROFILE_NOT_READY", 0, 0, 0, None)
        seeds = list(
            self.session.execute(
                select(RecommendationProfileArtist, Artist)
                .join(Artist, Artist.id == RecommendationProfileArtist.artist_id)
                .where(RecommendationProfileArtist.profile_id == profile.id)
                .order_by(
                    RecommendationProfileArtist.affinity.desc(),
                    RecommendationProfileArtist.confidence.desc(),
                    Artist.id,
                )
                .limit(self.seed_budget)
            )
        )
        preference = self.session.scalar(
            select(UserLivePreference).where(UserLivePreference.user_id == user.id)
        )
        all_ranked: dict[UUID, tuple[float, UUID, dict[str, object]]] = {}
        matched_artists = 0
        blocked_status: str | None = None
        for profile_artist, artist in seeds:
            result = await self.search(
                artist.name,
                user=user,
                country=preference.country if preference else None,
                city=preference.city if preference else None,
            )
            if result.status in {
                LiveResultStatus.OK.value,
                LiveResultStatus.PARTIAL_RESULTS.value,
            } and (result.matches or result.events):
                matched_artists += 1
            elif result.status in {
                LiveResultStatus.PROVIDER_NOT_CONFIGURED.value,
                LiveResultStatus.PROVIDER_UNAVAILABLE.value,
                LiveResultStatus.PROVIDER_RATE_LIMITED.value,
            }:
                blocked_status = result.status
            event_ids = [event.id for event in result.events]
            for event_id in event_ids:
                event = self.session.get(ConcertEvent, event_id)
                if event is None:
                    continue
                if event.artist_id is None:
                    event.artist_id = artist.id
                for performer in self.session.scalars(
                    select(ConcertPerformer).where(ConcertPerformer.event_id == event.id)
                ):
                    if normalize_artist_name(performer.name) == normalize_artist_name(artist.name):
                        performer.artist_id = artist.id
                days = max(0, (event.start_date - datetime.now(UTC).date()).days)
                proximity = max(0.0, 1.0 - min(days, 365) / 365)
                location_match = bool(
                    preference
                    and (
                        (preference.city and event.city == preference.city)
                        or (preference.country and event.country == preference.country)
                    )
                )
                score = profile_artist.affinity * 0.7 + profile_artist.confidence * 0.15 + proximity * 0.15
                if location_match:
                    score += 0.08
                evidence: dict[str, object] = {
                    "artist_name": artist.name,
                    "artist_affinity": round(profile_artist.affinity, 6),
                    "track_count": profile_artist.distinct_tracks,
                    "playlist_count": profile_artist.distinct_playlists,
                    "seed_confidence": round(profile_artist.confidence, 6),
                    "location_match": location_match,
                }
                current = all_ranked.get(event_id)
                if current is None or score > current[0]:
                    all_ranked[event_id] = (score, artist.id, evidence)
        if not all_ranked:
            return LiveRefreshResult(
                blocked_status or "NO_UPCOMING_EVENTS",
                len(seeds),
                matched_artists,
                0,
                None,
            )

        generated_at = datetime.now(UTC)
        self.session.execute(delete(LiveRecommendation).where(LiveRecommendation.user_id == user.id))
        ranked = sorted(all_ranked.items(), key=lambda value: (-value[1][0], str(value[0])))
        for rank, (event_id, (score, artist_id, evidence)) in enumerate(ranked, start=1):
            self.session.add(
                LiveRecommendation(
                    user_id=user.id,
                    event_id=event_id,
                    artist_id=artist_id,
                    rank=rank,
                    score=round(score, 8),
                    evidence=evidence,
                    generated_at=generated_at,
                    expires_at=generated_at + self.cache_ttl,
                )
            )
        self.session.flush()
        return LiveRefreshResult("FRESH", len(seeds), matched_artists, len(ranked), generated_at)

    def _deduplication_candidate(self, incoming: ProviderConcertEvent) -> ConcertEvent | None:
        candidates = list(
            self.session.scalars(
                select(ConcertEvent).where(ConcertEvent.start_date == incoming.start_date)
            )
        )
        incoming_performers = {normalize_artist_name(value.name) for value in incoming.performers}
        venue = normalize_artist_name(incoming.venue.name or "")
        city = normalize_artist_name(incoming.venue.city or "")
        title = normalize_artist_name(incoming.title)
        for candidate in candidates:
            performers = {
                normalize_artist_name(value)
                for value in self.session.scalars(
                    select(ConcertPerformer.name).where(ConcertPerformer.event_id == candidate.id)
                )
            }
            candidate_venue = normalize_artist_name(candidate.venue_name or "")
            candidate_city = normalize_artist_name(candidate.city or "")
            title_similarity = SequenceMatcher(
                None, title, normalize_artist_name(candidate.title)
            ).ratio()
            if (
                incoming_performers & performers
                and venue
                and venue == candidate_venue
                and city
                and city == candidate_city
                and title_similarity >= 0.78
            ):
                return candidate
        return None

    @staticmethod
    def _new_event(value: ProviderConcertEvent) -> ConcertEvent:
        now = datetime.now(UTC)
        return ConcertEvent(
            title=value.title,
            primary_artist_name=value.primary_artist_name,
            start_date=value.start_date,
            start_time=value.start_time,
            timezone=value.timezone,
            venue_name=value.venue.name,
            venue_address=value.venue.address,
            city=value.venue.city,
            region=value.venue.region,
            country=value.venue.country,
            latitude=value.venue.latitude,
            longitude=value.venue.longitude,
            artwork_url=value.artwork_url,
            event_url=value.event_url,
            ticket_url=value.ticket_url,
            status=value.status,
            observed_at=value.observed_at or now,
            last_refreshed_at=now,
            source_metadata={"canonical_provider": value.provider},
        )

    def _should_refresh_canonical(self, event: ConcertEvent, incoming_provider: str) -> bool:
        current = event.source_metadata.get("canonical_provider")
        if not isinstance(current, str):
            providers = list(
                self.session.scalars(
                    select(ConcertEventSource.provider).where(
                        ConcertEventSource.event_id == event.id
                    )
                )
            )
            current = min(providers, key=self._provider_rank, default=incoming_provider)
        return self._provider_rank(incoming_provider) <= self._provider_rank(current)

    def _provider_rank(self, provider: str) -> tuple[int, str]:
        return (self.provider_priority.get(provider, 100), provider)

    @classmethod
    def _refresh_source(
        cls, source: ConcertEventSource, value: ProviderConcertEvent
    ) -> None:
        source.event_url = value.event_url
        source.ticket_url = value.ticket_url or source.ticket_url
        source.status = value.status if value.status is not None else source.status
        source.last_refreshed_at = datetime.now(UTC)
        incoming = cls._source_payload(value)
        previous = source.source_payload if isinstance(source.source_payload, dict) else {}
        previous_normalized = previous.get("normalized", {})
        if not isinstance(previous_normalized, dict):
            previous_normalized = {}
        incoming_normalized = incoming["normalized"]
        assert isinstance(incoming_normalized, dict)
        for key in ("performers", "start_time", "timezone", "artwork_url", "status"):
            if not incoming_normalized.get(key) and previous_normalized.get(key):
                incoming_normalized[key] = previous_normalized[key]
        previous_venue = previous_normalized.get("venue", {})
        incoming_venue = incoming_normalized["venue"]
        if isinstance(previous_venue, dict) and isinstance(incoming_venue, dict):
            for key, previous_value in previous_venue.items():
                if incoming_venue.get(key) is None and previous_value is not None:
                    incoming_venue[key] = previous_value
        previous_metadata = previous.get("provider_metadata", {})
        if isinstance(previous_metadata, dict):
            incoming["provider_metadata"] = {
                **previous_metadata,
                **value.metadata,
            }
        source.source_payload = incoming

    @staticmethod
    def _source_payload(value: ProviderConcertEvent) -> dict[str, object]:
        return {
            "provider_metadata": value.metadata,
            "normalized": {
                "title": value.title,
                "performers": [performer.name for performer in value.performers],
                "start_date": value.start_date.isoformat(),
                "start_time": value.start_time.isoformat() if value.start_time else None,
                "timezone": value.timezone,
                "venue": {
                    "name": value.venue.name,
                    "address": value.venue.address,
                    "city": value.venue.city,
                    "region": value.venue.region,
                    "country": value.venue.country,
                    "latitude": value.venue.latitude,
                    "longitude": value.venue.longitude,
                },
                "artwork_url": value.artwork_url,
                "status": value.status,
            },
        }

    @staticmethod
    def _refresh_event(event: ConcertEvent, value: ProviderConcertEvent) -> None:
        event.title = value.title
        event.primary_artist_name = value.primary_artist_name or event.primary_artist_name
        event.start_date = value.start_date
        event.start_time = value.start_time if value.start_time is not None else event.start_time
        event.timezone = value.timezone or event.timezone
        event.venue_name = value.venue.name or event.venue_name
        event.venue_address = value.venue.address or event.venue_address
        event.city = value.venue.city or event.city
        event.region = value.venue.region or event.region
        event.country = value.venue.country or event.country
        event.latitude = (
            value.venue.latitude if value.venue.latitude is not None else event.latitude
        )
        event.longitude = (
            value.venue.longitude if value.venue.longitude is not None else event.longitude
        )
        event.artwork_url = value.artwork_url or event.artwork_url
        event.event_url = value.event_url
        event.ticket_url = value.ticket_url or event.ticket_url
        event.status = value.status if value.status is not None else event.status
        event.last_refreshed_at = datetime.now(UTC)

    def _merge_performers(self, event: ConcertEvent, value: ProviderConcertEvent) -> None:
        existing = list(
            self.session.scalars(
                select(ConcertPerformer)
                .where(ConcertPerformer.event_id == event.id)
                .order_by(ConcertPerformer.position)
            )
        )
        by_name = {normalize_artist_name(item.name): item for item in existing}
        for performer in value.performers:
            key = normalize_artist_name(performer.name)
            current = by_name.get(key)
            if current is None:
                current = ConcertPerformer(
                    event_id=event.id,
                    artist_id=performer.canonical_artist_id,
                    name=performer.name,
                    position=len(existing),
                    provider_identities={},
                )
                self.session.add(current)
                existing.append(current)
                by_name[key] = current
            if performer.provider_id:
                current.provider_identities = {
                    **current.provider_identities,
                    value.provider: performer.provider_id,
                }
            if performer.canonical_artist_id and current.artist_id is None:
                current.artist_id = performer.canonical_artist_id

    def _resolve_alias(self, query: str, user: User) -> str:
        normalized = normalize_artist_name(query)
        alias = self.session.scalar(
            select(ArtistSearchAlias)
            .where(
                ArtistSearchAlias.normalized_alias == normalized,
                ArtistSearchAlias.verified.is_(True),
                (ArtistSearchAlias.user_id == user.id) | (ArtistSearchAlias.user_id.is_(None)),
            )
            .order_by(ArtistSearchAlias.user_id.desc().nullslast())
            .limit(1)
        )
        return alias.canonical_name if alias is not None else query

    def _events_by_ids(
        self, event_ids: list[str], *, date_filter: str, today: date
    ) -> list[ConcertEvent]:
        if not event_ids:
            return []
        ids = [UUID(value) for value in event_ids]
        events = list(
            self.session.scalars(
                select(ConcertEvent)
                .where(ConcertEvent.id.in_(ids), ConcertEvent.start_date >= today)
                .order_by(ConcertEvent.start_date, ConcertEvent.start_time, ConcertEvent.id)
            )
        )
        return [event for event in events if self._date_matches(event.start_date, date_filter, today)]

    @staticmethod
    def _date_matches(value: date, date_filter: str, today: date) -> bool:
        if date_filter == "month":
            return value.year == today.year and value.month == today.month
        if date_filter == "three_months":
            return value <= today + timedelta(days=93)
        return True

    def _cache_key(self, query: str, country: str | None, city: str | None) -> str:
        provider_scope = ",".join(
            f"{provider.provider_name}:{self._provider_enabled(provider)}"
            for provider in sorted(
                self.aggregator.providers, key=lambda value: value.provider_name
            )
            if ConcertCapability.ARTIST_SEARCH in provider.capabilities
            or ConcertCapability.EVENT_SEARCH in provider.capabilities
        )
        value = "|".join(
            [
                normalize_artist_name(query),
                (country or "").upper(),
                (city or "").casefold(),
                provider_scope,
            ]
        )
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def _provider_enabled(provider: ConcertProvider) -> bool:
        enabled = getattr(provider, "enabled", None)
        if isinstance(enabled, bool):
            return enabled
        health = provider.health()
        return health.state.value != "NOT_CONFIGURED"

    @staticmethod
    def _as_utc(value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
