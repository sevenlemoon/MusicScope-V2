# Live concert intelligence

MusicScope Live is a cache-backed application service, not a browser-to-provider proxy. The
browser consumes normalized MusicScope DTOs; server-only adapters own provider credentials,
request budgets, retries, health, and vendor response mapping.

## Two discovery modes

MusicScope deliberately separates routine reads from explicit network discovery.

**Materialized/cached discovery** serves Live For You, the Home teaser, Artist Upcoming Live,
previous searches, and the default Live feed. Those reads query MusicScope's database only.

**On-demand federated search** is used only after an explicit artist search. The aggregator selects
enabled providers with a safe search capability, runs them concurrently within strict limits,
normalizes and conservatively reconciles the results, stores source provenance, and materializes
verified events for reuse.

```text
Live UI / Home / Artist page
    -> FastAPI Live routes
        -> LiveConcertService
            -> verified materialized cache (normal reads)
            -> ConcertAggregator (explicit refresh/search)
                -> capability-selected provider adapters
                -> normalized events and source provenance
                -> conservative identity reconciliation
```

Provider requests occur only for explicit search or refresh operations. A fresh search-cache hit
returns immediately without provider calls. If an expired entry still contains verified events and
refresh fails, MusicScope returns that verified entry as `stale` with honest coverage state. It
does not invent data or persist raw upstream pages.

## Capabilities and rollout state

Providers declare only operations supported by their current adapter. Unsupported operations fail
explicitly and cannot be selected by the aggregator.

| Provider | Status | Declared capabilities | Constraints |
| --- | --- | --- | --- |
| Ticketmaster | Core | Artist search, event search/list/detail/status, pagination, venue detail | Official Discovery API; server-side key; bounded to three pages, about two requests/second, and one transient retry |
| AsiaWorld-Expo verified registry | Trusted official | Artist search, event search/list/detail/status, venue detail | Fixed server-side registry entry; official venue Event JSON-LD first, bounded server-rendered calendar-slot fallback, strict host/DNS/redirect/content limits, and no user-controlled fetch URL |
| Maoyan | Experimental, off by default | Event list, pagination, event status | The current public entry point returned only a branded shell during R3.1 QA. No verified search/detail adapter and no private-client emulation |
| KKTIX | Experimental, off by default | Event search/list/detail/status, pagination, venue detail | Public discovery pages exist, but a normal bounded request was blocked with HTTP 403. No Cloudflare bypass; runtime remains disabled |
| ShowStart | Experimental, off by default | Event search/list/detail, pagination, venue detail | Anonymous public server-rendered HTML only. R3.1 verified keyword search and detail; no script execution or signed/private protocol |
| Damai | Deferred | None | Official distribution APIs require application signing and are scoped to authorized/distribution projects. Add only after legitimate partner credentials; do not scrape the consumer site |
| MoreTickets | Rejected for R3.1 | None | No stable official/public discovery interface was verified |
| Piaoxingqiu | Rejected for R3.1 | None | Public shell exposes no stable anonymous discovery interface; protected client protocols are out of scope |

Classification is evidence-based rather than geographic. Ticketmaster remains the broad core
provider. R3.1.1 adds a narrow registry of reviewed first-party pages for gaps where a venue or
artist source has stronger coverage. Registry configuration may identify the source and exact
artist aliases, but event title, dates, times, venue, artwork, and ticket navigation are always
parsed from the live upstream document. ShowStart remains an experimental secondary discovery path
because ordinary anonymous public HTML was verified end to end. Maoyan and KKTIX remain disabled
declarations for future reevaluation, not production coverage claims.

## Bounded federated search

- Provider work is concurrent with a maximum concurrency of 3.
- Each provider has an 8-second outer timeout and the whole interactive search has a 10-second
  deadline. A slow source is cancelled and cannot suppress completed results.
- Ticketmaster uses a 6-second request timeout, at most one retry for transient failures, a
  0.5-second minimum interval (about two requests/second), and at most two pages by default (hard
  maximum three).
- ShowStart uses a 5-second request timeout, no retry, a one-second minimum interval, and at most
  two public list pages (one in the current interactive budget).
- Verified official pages use a 6-second timeout, a 2 MB response ceiling, at most three validated
  redirects, HTTPS-only allowlisted hosts, and public-IP DNS validation on every hop. Browser input
  can select a verified artist identity but can never supply or alter the backend fetch URL.
- Successful search results are cached for 30 minutes. The key includes the normalized query,
  explicit location parameters, and the stable enabled/configured search-provider set.
- Materialized Live recommendations expire after 6 hours. Past events are excluded from upcoming
  reads. Explicit refresh may update provider status or event detail.
- Three consecutive provider failures open a five-minute in-process circuit. HTTP 429 becomes
  `RATE_LIMITED`; it never erases results from another provider.

The API returns one bounded response containing independent provider outcomes. The UI first shows
an accessible searching state, then provider status/count chips. WebSockets are unnecessary for
this bounded request.

## Identity, conflicts, and provenance

`(provider, provider_event_id)` is authoritative within one source. A logical `ConcertEvent` keeps
one or more `ConcertEventSource` rows and ordered `ConcertPerformer` rows. Cross-provider merging
requires the same local date, overlapping normalized performer evidence, exact venue/city evidence,
and a similar title. If evidence is incomplete, events remain separate.

Unknown times stay unknown. Missing fields are not invented. Provider event links remain HTTPS.
Ticket navigation from verified pages is retained only for explicitly reviewed ticket hosts; a
legacy upstream HTTP link may be normalized to HTTPS but cannot redirect backend fetching.

Verified aliases are exact registry relationships backed by named first-party evidence. They are
persisted through `ArtistSearchAlias` only after a verified source produces materializable event
evidence. No generic Japanese/Latin transliteration or cross-script similarity rule exists.

When sources disagree, normalized source snapshots are retained in each source payload. A stable
priority (official Ticketmaster before experimental sources) controls which source may refresh the
logical event. A sparse list refresh cannot erase richer verified detail from the same source;
non-null status, time, address, coordinates, artwork, and ticket data are preserved until replaced
by newer explicit values. Uncertain matches remain separate rather than being aggressively merged.

## Personalization and location

Live For You uses at most 12 high-confidence artists from the existing recommendation profile and
records the evidence attached to each recommendation. It uses verified search cache before any
provider refresh. User preferences and cached recommendations are user-scoped. Location filters are
explicit user settings; MusicScope does not silently infer or overwrite them.

## Failure behavior

Provider health is represented as `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `NOT_CONFIGURED`,
`RATE_LIMITED`, or `CIRCUIT_OPEN`. Failures are isolated per provider, and the circuit breaker
prevents repeated calls to an unhealthy source. API coverage codes distinguish artist mismatch,
ambiguity, provider failure, rate limiting, partial results, and verified empty responses so the UI
does not claim global concert absence from one provider's result.

Provider outcomes also retain `PARSER_CHANGED`, `TIMEOUT`, and `UNAVAILABLE` as distinct evidence.
None is rewritten as `NO_UPCOMING_EVENTS`. If an expired search cache contains verified events and
a partial refresh yields no fresh events because one source failed, MusicScope returns the stale
verified records instead of replacing them with an empty cache entry.

## Credentials and safety boundary

`TICKETMASTER_API_KEY` is server-only. Potential future Damai credentials would likewise be
server-only. Neither credentials nor raw provider responses appear in DTOs, OpenAPI, frontend
environment variables, source provenance, or logs.

Adapters perform public read-only discovery only. MusicScope does not automate login, checkout,
seat locking, purchase, CAPTCHA handling, WAF/Cloudflare bypass, private request signing, mobile
client impersonation, or rate-limit evasion. Public HTML is parsed as untrusted text without
executing scripts, and only the normalized fields needed by the domain model are retained.

## Known coverage gaps

Ticketmaster needs a locally configured Consumer Key for real core-provider QA. Legitimate Mainland
China discovery remains limited: ShowStart supplies a real but experimental public path, while
Damai requires partner/distributor credentials and no stable public Maoyan, MoreTickets, or
Piaoxingqiu search interface was verified. KKTIX's normal public search request was blocked in this
environment. One provider result, including zero events, never implies that an artist has no live
performances globally.
