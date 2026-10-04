# Windows beta.2 automated acceptance — 2026-10-04

The Windows job in [run 37171901408](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37171901408)
passed at source commit `550a423e842a803e1aebc4fcdb7ff31a1cf08cca`.
The overall run failed because Linux's sidecar dependency audit failed; it is
not a release-ready validation result.

The generated four-second stereo signal passed these checks using the relocated
bundled package, with Unicode/space-containing package and profile paths:

- Two Electron launches, Studio/API/worker readiness, and preserved key/database.
- First CPU six-stem job with an initially empty model cache: 13.27 seconds.
- External TCP positive control reachable before firewall rules and blocked after.
- Reopened existing results offline through Electron; all six controls and export
  links present, playback position advanced, and playback returned to ended state.
- A new CPU six-stem job in an empty second profile with outbound traffic blocked:
  13.22 seconds. Six FLAC downloads passed hash, duration, decoding and waveform checks.

Original reports retrieved from artifact `11291897498`:

- [First job](windows-audio-37171901408.json).
- [New offline job](windows-offline-37171901408.json).
- [Packaged player](windows-playback-37171901408.json).

The artifact is `musicscope-windows-desktop` (572,019,596 bytes). GitHub records
outer archive SHA-256 `0ea92e9e4d25f580466b5c21fd910bb49925b40a8784542d605d08c43f51b137`.
The included checksum file reports inner package SHA-256
`375a16c546676111510a0fc59eb5a4b2a3e842da489526e081560439c954cf04`.
Only small report/checksum entries were retrieved using HTTP ranges; the full
archive and package hashes were **not independently recomputed** in this review.

This run predates the Next.js 16.3.8/basic-ftp 6.2.1 patch update in `a31af45`;
[run 37172690567](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37172690567)
validates that revision separately. Do not apply this result to a different build.

These are generated-signal checks, not speaker listening, music quality, a clean
Windows VM/standard-user test, a real Unicode Windows account, or a beta.1 binary
upgrade test. No new release has been published. Remaining upstream dependency
advisories are recorded in [the dependency audit](dependency-audit-2026-10-04.md).
