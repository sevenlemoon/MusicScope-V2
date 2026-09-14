# R1 — real NetEase integration sequence

1. Select and pin a server-side NetEase API implementation after license, maintenance, and endpoint verification. Record an ADR; do not copy a player UI or renderer-side cookie storage.
2. Implement the `NetEaseProvider` HTTP client with strict response parsing, redacted diagnostics, timeouts, retry classification, and a server-managed cookie jar.
3. Implement `POST /connections/netease/qr` to create a short-lived connection attempt and return only QR image/content, public attempt ID, expiry, and state.
4. Implement polling through MusicScope (`GET /connections/{id}/auth-state`) and map provider codes 801/802/803/800 to `WAITING_SCAN`, `WAITING_CONFIRM`, `CONNECTED`, and `EXPIRED`.
5. On 803, persist encrypted session material in `MusicConnectionSecret`; fetch `/user/account`; update non-sensitive connection metadata. Never return cookies to the browser.
6. Add disconnect, expiry detection, refresh, reconnect, and cancellation. Ensure old polling attempts cannot win races after refresh/navigation.
7. Implement a paginated playlist inventory and store provider playlist identities idempotently.
8. Fetch complete playlist track IDs, then request song details in measured batches with bounded concurrency. Normalize multi-artist and album relationships plus source-native artwork.
9. Reconcile `PlaylistTrack`, `ExternalIdentity`, and `LibraryItem` in small transactions. Track progress/errors in `SyncState`; tolerate partial records and deduplicate across playlists.
10. Add unit tests for every auth state and response mapper, integration tests against a controllable HTTP fake, large-sync/retry/idempotency tests, and logging redaction tests.
11. Perform real-world verification: generate a real QR, scan/confirm in the official app, fetch the account and a large library, disconnect/reconnect, and document observed provider limits. This human scan is the gate for calling R1 complete.

