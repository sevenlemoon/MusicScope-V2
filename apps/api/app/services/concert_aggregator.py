from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from app.providers.concert import (
    ArtistMatchResult,
    ArtistMatchState,
    ConcertCapability,
    ConcertProvider,
    ProviderConcertEvent,
    ProviderHealthState,
)
from app.providers.errors import (
    ProviderCapabilityUnavailable,
    ProviderNotConfigured,
    ProviderParserChanged,
    ProviderRateLimited,
    ProviderTemporarilyUnavailable,
    ProviderTimeout,
)


class LiveResultStatus(StrEnum):
    OK = "OK"
    ARTIST_NOT_FOUND = "ARTIST_NOT_FOUND"
    NO_UPCOMING_EVENTS = "NO_UPCOMING_EVENTS"
    AMBIGUOUS_ARTIST = "AMBIGUOUS_ARTIST"
    PROVIDER_NOT_CONFIGURED = "PROVIDER_NOT_CONFIGURED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED"
    PARTIAL_RESULTS = "PARTIAL_RESULTS"


@dataclass
class CircuitState:
    failures: int = 0
    open_until: datetime | None = None


class ProviderCircuitBreaker:
    def __init__(self, failure_threshold: int = 3, cooldown_seconds: int = 300) -> None:
        self.failure_threshold = failure_threshold
        self.cooldown = timedelta(seconds=cooldown_seconds)
        self._states: dict[str, CircuitState] = {}

    def is_open(self, provider: str, now: datetime | None = None) -> bool:
        state = self._states.get(provider)
        current = now or datetime.now(UTC)
        if state is None or state.open_until is None:
            return False
        if state.open_until <= current:
            state.open_until = None
            state.failures = 0
            return False
        return True

    def success(self, provider: str) -> None:
        self._states[provider] = CircuitState()

    def failure(self, provider: str, now: datetime | None = None) -> None:
        current = now or datetime.now(UTC)
        state = self._states.setdefault(provider, CircuitState())
        state.failures += 1
        if state.failures >= self.failure_threshold:
            state.open_until = current + self.cooldown


@dataclass(frozen=True)
class ProviderSearchResult:
    provider: str
    status: str
    result_count: int
    latency_ms: int
    match_state: str | None = None


@dataclass(frozen=True)
class AggregatedConcertSearch:
    query: str
    status: LiveResultStatus
    events: tuple[ProviderConcertEvent, ...] = ()
    matches: tuple[dict[str, str | None], ...] = ()
    provider_states: dict[str, str] = field(default_factory=dict)
    provider_results: tuple[ProviderSearchResult, ...] = ()
    partial: bool = False


@dataclass(frozen=True)
class _ProviderAttempt:
    result: ProviderSearchResult
    health: ProviderHealthState
    events: tuple[ProviderConcertEvent, ...] = ()
    matches: tuple[dict[str, str | None], ...] = ()


class ConcertAggregator:
    def __init__(
        self,
        providers: list[ConcertProvider],
        *,
        circuit_breaker: ProviderCircuitBreaker | None = None,
        page_budget: int = 2,
        max_concurrency: int = 3,
        provider_timeout_seconds: float = 8.0,
        search_deadline_seconds: float = 10.0,
    ) -> None:
        self.providers = providers
        self.circuit_breaker = circuit_breaker or ProviderCircuitBreaker()
        self.page_budget = max(1, min(page_budget, 3))
        self.max_concurrency = max(1, min(max_concurrency, 4))
        self.provider_timeout = max(0.05, min(provider_timeout_seconds, 15.0))
        self.search_deadline = max(
            self.provider_timeout, min(search_deadline_seconds, 20.0)
        )

    async def search_artist(
        self,
        query: str,
        *,
        country: str | None = None,
        city: str | None = None,
    ) -> AggregatedConcertSearch:
        clean_query = " ".join(query.split())
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def run(provider: ConcertProvider) -> _ProviderAttempt:
            async with semaphore:
                try:
                    return await asyncio.wait_for(
                        self._search_provider(provider, clean_query, country=country, city=city),
                        timeout=self.provider_timeout,
                    )
                except TimeoutError:
                    self.circuit_breaker.failure(provider.provider_name)
                    return self._failure_attempt(
                        provider.provider_name, ProviderHealthState.UNAVAILABLE, "TIMEOUT"
                    )

        tasks = [asyncio.create_task(run(provider)) for provider in self.providers]
        done, pending = await asyncio.wait(tasks, timeout=self.search_deadline)
        attempts = [task.result() for task in done]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            completed_names = {attempt.result.provider for attempt in attempts}
            for provider in self.providers:
                if provider.provider_name not in completed_names:
                    self.circuit_breaker.failure(provider.provider_name)
                    attempts.append(
                        self._failure_attempt(
                            provider.provider_name,
                            ProviderHealthState.UNAVAILABLE,
                            "DEADLINE_EXCEEDED",
                        )
                    )
        order = {provider.provider_name: index for index, provider in enumerate(self.providers)}
        attempts.sort(key=lambda value: order[value.result.provider])
        provider_states = {
            attempt.result.provider: attempt.health.value for attempt in attempts
        }
        events = [event for attempt in attempts for event in attempt.events]
        matches = [match for attempt in attempts for match in attempt.matches]
        successful = {
            "SUCCESS",
            ArtistMatchState.NOT_FOUND.value,
            ArtistMatchState.AMBIGUOUS.value,
        }
        failures = {
            ProviderHealthState.NOT_CONFIGURED.value,
            ProviderHealthState.UNAVAILABLE.value,
            ProviderHealthState.RATE_LIMITED.value,
            ProviderHealthState.CIRCUIT_OPEN.value,
            "TIMEOUT",
            "PARSER_CHANGED",
            "DEADLINE_EXCEEDED",
        }
        has_success = any(attempt.result.status in successful for attempt in attempts)
        has_failure = any(attempt.result.status in failures for attempt in attempts)
        partial = has_success and has_failure
        any_found = any(
            attempt.result.status == "SUCCESS"
            and attempt.result.match_state == ArtistMatchState.MATCHED.value
            for attempt in attempts
        )
        direct_search_completed = any(
            attempt.result.status == "SUCCESS" and attempt.result.match_state is None
            for attempt in attempts
        )
        any_ambiguous = any(
            attempt.result.status == ArtistMatchState.AMBIGUOUS.value for attempt in attempts
        )
        any_not_found = any(
            attempt.result.status == ArtistMatchState.NOT_FOUND.value for attempt in attempts
        )
        rate_limited = any(
            attempt.result.status == ProviderHealthState.RATE_LIMITED.value for attempt in attempts
        )
        unavailable = any(
            attempt.result.status
            in {
                ProviderHealthState.UNAVAILABLE.value,
                ProviderHealthState.CIRCUIT_OPEN.value,
                "TIMEOUT",
                "PARSER_CHANGED",
                "DEADLINE_EXCEEDED",
            }
            for attempt in attempts
        )
        not_configured = any(
            attempt.result.status == ProviderHealthState.NOT_CONFIGURED.value
            for attempt in attempts
        )

        if partial:
            status = LiveResultStatus.PARTIAL_RESULTS
        elif events:
            status = LiveResultStatus.OK
        elif any_ambiguous and not any_found:
            status = LiveResultStatus.AMBIGUOUS_ARTIST
        elif any_found or direct_search_completed:
            status = LiveResultStatus.NO_UPCOMING_EVENTS
        elif any_not_found:
            status = LiveResultStatus.ARTIST_NOT_FOUND
        elif rate_limited:
            status = LiveResultStatus.PROVIDER_RATE_LIMITED
        elif unavailable:
            status = LiveResultStatus.PROVIDER_UNAVAILABLE
        elif not_configured:
            status = LiveResultStatus.PROVIDER_NOT_CONFIGURED
        else:
            status = LiveResultStatus.PROVIDER_UNAVAILABLE
        return AggregatedConcertSearch(
            query=clean_query,
            status=status,
            events=tuple(events),
            matches=tuple(matches),
            provider_states=provider_states,
            provider_results=tuple(attempt.result for attempt in attempts),
            partial=partial,
        )

    async def _search_provider(
        self,
        provider: ConcertProvider,
        query: str,
        *,
        country: str | None,
        city: str | None,
    ) -> _ProviderAttempt:
        name = provider.provider_name
        started = asyncio.get_running_loop().time()
        if self.circuit_breaker.is_open(name):
            return self._failure_attempt(
                name, ProviderHealthState.CIRCUIT_OPEN, ProviderHealthState.CIRCUIT_OPEN.value
            )
        can_match_artist = ConcertCapability.ARTIST_SEARCH in provider.capabilities
        can_search_events = ConcertCapability.EVENT_SEARCH in provider.capabilities
        if not can_match_artist and not can_search_events:
            return self._attempt(name, "UNSUPPORTED", ProviderHealthState.DEGRADED, started)
        try:
            if can_match_artist:
                match = await provider.search_artists(query)
                safe_matches = tuple(self._safe_matches(name, match))
                if match.state != ArtistMatchState.MATCHED:
                    return self._attempt(
                        name,
                        match.state.value,
                        provider.health().state,
                        started,
                        match_state=match.state.value,
                        matches=safe_matches,
                    )
                attraction = match.matches[0]
                found = await provider.search_events(
                    attraction_id=attraction.provider_id,
                    country=country,
                    city=city,
                    page_budget=self.page_budget,
                )
                match_state = match.state.value
                matches = safe_matches
            else:
                found = await provider.search_events(
                    query=query,
                    country=country,
                    city=city,
                    page_budget=self.page_budget,
                )
                match_state = None
                matches = ()
            self.circuit_breaker.success(name)
            return self._attempt(
                name,
                "SUCCESS",
                provider.health().state,
                started,
                events=tuple(found),
                matches=matches,
                match_state=match_state,
            )
        except ProviderNotConfigured:
            return self._attempt(
                name,
                ProviderHealthState.NOT_CONFIGURED.value,
                ProviderHealthState.NOT_CONFIGURED,
                started,
            )
        except ProviderRateLimited:
            self.circuit_breaker.failure(name)
            return self._attempt(
                name,
                ProviderHealthState.RATE_LIMITED.value,
                ProviderHealthState.RATE_LIMITED,
                started,
            )
        except ProviderParserChanged:
            self.circuit_breaker.failure(name)
            return self._attempt(
                name,
                "PARSER_CHANGED",
                ProviderHealthState.DEGRADED,
                started,
            )
        except ProviderTimeout:
            self.circuit_breaker.failure(name)
            return self._attempt(
                name,
                "TIMEOUT",
                ProviderHealthState.UNAVAILABLE,
                started,
            )
        except (ProviderTemporarilyUnavailable, ProviderCapabilityUnavailable):
            self.circuit_breaker.failure(name)
            return self._attempt(
                name,
                ProviderHealthState.UNAVAILABLE.value,
                ProviderHealthState.UNAVAILABLE,
                started,
            )

    @staticmethod
    def _attempt(
        provider: str,
        status: str,
        health: ProviderHealthState,
        started: float,
        *,
        events: tuple[ProviderConcertEvent, ...] = (),
        matches: tuple[dict[str, str | None], ...] = (),
        match_state: str | None = None,
    ) -> _ProviderAttempt:
        latency_ms = max(0, round((asyncio.get_running_loop().time() - started) * 1000))
        return _ProviderAttempt(
            result=ProviderSearchResult(
                provider=provider,
                status=status,
                result_count=len(events),
                latency_ms=latency_ms,
                match_state=match_state,
            ),
            health=health,
            events=events,
            matches=matches,
        )

    @staticmethod
    def _failure_attempt(
        provider: str, health: ProviderHealthState, status: str
    ) -> _ProviderAttempt:
        return _ProviderAttempt(
            result=ProviderSearchResult(provider, status, 0, 0),
            health=health,
        )

    @staticmethod
    def _safe_matches(provider: str, result: ArtistMatchResult) -> list[dict[str, str | None]]:
        return [
            {
                "provider": provider,
                "provider_artist_id": match.provider_id,
                "name": match.name,
                "artwork_url": match.image_url,
            }
            for match in result.matches
        ]
