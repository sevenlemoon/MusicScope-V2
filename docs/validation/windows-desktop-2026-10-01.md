# Windows bundled-runtime acceptance

Reviewed on 2026-10-04. The execution below took place on 2026-10-01; this
review does not represent a second Windows run.

## Source and provenance

- Commit: `f008dea3e91a580f6b404a3f937a80d6e6d9ce2f`.
- Branch: `codex/windows-bundled-runtime`.
- [Validation run 36874048404](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/36874048404):
  Linux and Windows jobs both succeeded.
- [Windows job](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/36874048404/job/110408805460):
  2026-10-01 14:08:51–14:32:59 UTC, on `windows-latest`.
- Artifact: `musicscope-windows-desktop`, ID `11169362748`.
- Outer GitHub artifact archive: 571,963,533 bytes;
  SHA-256 `1ee910482974f342e3ffd954b90d4565788d9cb7e20dd310545f9ecf2e6464cd`.
- GitHub reports artifact expiry on 2026-12-30. This is a CI artifact, not a
  permanent release download.

The package inside this artifact still uses the filename and application
version `0.1.0-beta.1`. It contains different code from the publicly released
beta.1 at commit `2e985334236c52a22dcddbfcf58dd0c25ad4f739`. Do not identify an
installation by filename alone, replace the old release asset, or pass this
branch run to the current master-only release workflow. A new release requires
a new version and validation of that exact build.

## Executed checks

| Check | Evidence | Result |
| --- | --- | --- |
| Windows unit checks | 74 API, 15 audio worker, 23 frontend, 4 sidecar, 4 desktop tests | Passed |
| Frontend | Lint, TypeScript and production build | Passed |
| Source launcher | Full native Windows startup without Docker/WSL | Passed |
| Production package | Private Python/Node/FFmpeg and Next.js standalone build | Passed |
| Relocation | ZIP extracted into `用户 with spaces` under a unique temporary directory | Passed |
| Application startup | Two Electron launches with developer tools removed from PATH | Passed |
| Application readiness | Studio DOM, jobs API, worker heartbeat and screenshot | Passed |
| Restart preservation | Same `.env` hash and database creation timestamp | Passed |
| Separation | Bundled worker, CPU, `htdemucs_6s`, isolated initially empty model cache | Passed |
| Outputs | Six distinct stems; duration, 44.1 kHz, stereo, FLAC signature/size/SHA-256, decoding and waveform checks | Passed |

The four-second deterministic stereo signal completed the acceptance flow in
**20.92 seconds**. This is the script's total elapsed time, including its API
readiness wait, upload, task processing and output checks; it is not a pure
inference benchmark and does not predict full-song performance.

The isolated application profile was `isolated profile`, not a Windows account
with a Unicode username. The real separation was submitted through the API to
the packaged supervisor after Electron's startup check; the test did not click
through file import, playback or export in the UI.

## What remains before release

- A clean Windows 10/11 x64 VM with no developer runtimes, under a standard
  non-administrator account, including a Unicode Windows username.
- A licensed musical clip imported through the packaged UI, six-track playback,
  seeking, mute/solo, export and listening checks.
- A prepared model cache used after an offline restart; a separate interrupted
  first model download and retry scenario.
- Disk exhaustion and existing beta.1 data/account-key upgrade scenarios.
- Dependency redistribution review, a new release version, and validation tied
  to the new package checksum.

These are release gaps, not failures observed in this run. The current result
supports a working bundled Windows candidate; it does not establish a fully
offline product, musical separation quality, sound-device compatibility or
coverage of all Windows/GPU configurations.

## Follow-up verification on 2026-10-04

On the macOS checkout, the four desktop supervisor tests and nine database/audio
acceptance tests passed again. No runtime or packaging implementation was changed
for this evidence update.

The complete artifact was downloaded and its SHA-256 matched GitHub's recorded
digest. The inner package checksum and all ZIP entry CRCs also passed:

| Package property | Verified value |
| --- | --- |
| ZIP size | 582,289,742 bytes (582.29 MB / 555.31 MiB) |
| Uncompressed entry sizes | 1,695,284,346 bytes (1.70 GB; excludes filesystem overhead, models and user data) |
| Archive entries | 34,149 |
| Package SHA-256 | `14fb2258b1c3a209c690a79eb9a82ad1125aee2d5ae9d8b39bdaecdfb8387b83` |

The expected desktop entry points, both Python runtimes, Node, FFmpeg/ffprobe,
production web entry point and dependency inventories are present. The desktop
entry points and loading UI match the validated source. A filename scan found
no actual `.env`, Git metadata or project storage/log/virtualenv directories;
this is not a comprehensive secret audit. Native license files are present for
Electron, Node, Python and FFmpeg; this does not complete redistribution review.

The packaged screenshot was inspected and shows the local import Studio, with
no error screen. It was captured before separation and does not show the mixer.

- [Original audio acceptance report](windows-audio-36874048404.json).
- [Local package inspection report](windows-package-36874048404.json).
- The verified ZIP, checksum, original PNG and reports are retained locally in
  the ignored directory `dist/validation-36874048404/`. They are not committed
  as large repository files or published as a new release.
