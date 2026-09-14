# ADR 0002: Narrow enhanced NetEase API sidecar

## Status

Accepted for R1 real-world verification.

## Decision

Use `@neteasecloudmusicapienhanced/api` 4.40.1 through a MusicScope-owned,
loopback-only Node.js sidecar. FastAPI's `NetEaseProvider` is the only application caller. The
browser never calls the sidecar and never receives provider session material.

The sidecar imports only seven read/auth modules: QR key/create/check, account, user playlists,
playlist detail, and song detail (plus artist/album detail for the provider interface). It does
not expose the dependency's general-purpose server or provider-side mutation endpoints. Request
bodies and cookie values are never logged. Authentication material exists transiently in the
sidecar during QR polling, then is returned only over loopback to FastAPI for authenticated
encryption.

## Rationale

- The package is the actively published MIT continuation of the original API and is used by the
  current Hydrogen Music implementation.
- It provides the required 800/801/802/803 QR lifecycle, account profile, paginated user
  playlists, complete `playlist.trackIds`, batched song details, multi-artist data, albums, and
  native artwork.
- It is pure Node.js application code and runs on the pinned Apple-Silicon-compatible Node 24
  runtime without an additional container.
- A narrow local wrapper is operationally smaller and safer than independently reimplementing
  NetEase private crypto/protocol behavior in Python.

## Operational constraints

- Bind only to `127.0.0.1:36531`; FastAPI rejects non-loopback sidecar URLs.
- R1 performs only authentication and read operations.
- Song detail uses batches of 200 with concurrency 2 initially. These are conservative values
  below the implementation's documented 1000-ID ceiling and must be measured against the real
  account before R1 can pass.
- Transitive `qs` is overridden to 6.16.0 to remove the published audit finding. Both web and
  sidecar dependency trees must remain at zero known npm audit vulnerabilities.
