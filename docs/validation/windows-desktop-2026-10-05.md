# Windows dependency-fix acceptance — reviewed 2026-10-05

The subsequent notice-restoration package also passed; see
[the latest Windows acceptance](windows-notices-2026-10-05.md). The evidence below
is retained for its original dependency-fix artifact.

[Run 37207233930](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37207233930)
passed both Linux `check` and `windows` jobs at source commit
`a4f04ea3d3db885181d92cd73704a33be1cc4f3b`. The Windows job completed
2026-10-04 at 14:19:29 UTC (22:19:29 Asia/Shanghai).
This is the candidate containing both dependency replacements and the Windows
cross-drive glob correction.

## Dependency and code checks

- Full web (including development dependencies) and NetEase sidecar audit gates
  reported zero known vulnerabilities on both platforms. Windows desktop `npm ci`
  also reported zero known vulnerabilities.
- Windows passed 77 API tests, 18 worker tests, 25 UI tests, seven sidecar tests,
  three directory-glob dependency tests, lint, type checking and production build.
- Encryption fixtures and round trips passed; Next's actual link rule still
  reports violations. Deep brace nesting and Windows directory roots passed.
- After ZIP extraction to a different Unicode/space-containing path, bundled
  Node loaded the physical RSA adapter from inside the package and encrypted
  through the upstream provider. Developer tools were removed from PATH.

See [the dependency audit](dependency-audit-2026-10-04.md) for the replacement
scope and regression coverage. No audit gate was disabled or advisory suppressed.

## Packaged acceptance

The relocated package and isolated profile both used Unicode/space-containing
paths. The successful harness verified two Electron launches, Studio/API/worker
readiness and preservation of the existing encryption key and database.

Original reports retrieved from artifact `11306031233`:

- [First CPU six-stem job](windows-audio-37207233930.json): generated four-second
  stereo input, initially empty model cache, completed in 21.78 seconds.
- [New offline CPU job](windows-offline-37207233930.json): fresh second profile,
  prepared model cache and outbound traffic blocked, completed in 21.61 seconds.
  Both jobs verified all six FLAC downloads, hashes, durations, decoding and waveforms.
- [Offline packaged player](windows-playback-37207233930.json): six stem controls,
  advancing playback, ended state and six export links passed.

The log also confirms that the external TCP control was reachable before the
firewall rules and blocked afterwards. The harness restores firewall settings.

## Artifact identity

- [CI artifact](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37207233930/artifacts/11306031233):
  `musicscope-windows-desktop`, 571,622,154 bytes.
- GitHub-reported outer archive SHA-256:
  `154f04b796753b8f560e6ae7c46d21f06d61312e4d5833c9791df52ecd7f018b`.
- Included package: `MusicScope-0.1.0-beta.2-windows-x64.zip`, 581,859,183 bytes
  according to the artifact ZIP directory.
- [Included package checksum](windows-package-37207233930.zip.sha256):
  `c6761c0fa7043895fb5cec2a97a98470858a0ffcd4af2e82fffb89c434585353`.

The initial review retrieved only the ZIP directory and small report/checksum
entries using HTTP ranges. Report content was preserved with line endings
normalized to LF for the repository.

A subsequent full download on 2026-10-05 independently verified the inner
package SHA-256 above and all 34,103 ZIP entry CRCs. Uncompressed entry sizes total
1,693,749,220 bytes. Required runtimes are present, desktop entry points match
`a4f04ea`, and the selected private-state filename scan found no project `.env`,
Git metadata, storage or logs. See the [package inspection report](windows-package-37207233930.json).
The outer GitHub artifact digest was not independently recomputed.

This inspection also found missing root license notices for Next, React, React
DOM and the Windows Sharp package in the standalone web output. The subsequent
packaging fix and remaining redistribution work are tracked in
[redistribution preparation](redistribution-2026-10-05.md). Do not use this older
artifact to claim that the new notice-restoration check passed.

## Remaining release acceptance

The two dependency findings and the new candidate's automated Windows package
acceptance are resolved. No beta.2 release was published by this verification.
These generated-signal tests do not establish speaker listening or musical
quality. A clean Windows VM/standard-user test, real Unicode Windows account,
real beta.1 binary upgrade and redistribution review remain outstanding as
described in [desktop delivery](../DESKTOP_DELIVERY.md). First-time model
preparation still requires network access.
