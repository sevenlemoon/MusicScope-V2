# Windows notice-restoration acceptance — 2026-10-05

[Validation run 37276579470](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37276579470)
passed Linux and Windows at commit `582bc2454fb37a215158784140bf0ff23275f399`.
Windows completed at 07:37:00 UTC (15:37:00 Asia/Shanghai). This is the candidate
that restores dependency notices omitted from the standalone web output.

## Verified checks

- Four new notice regression tests passed on both operating systems, alongside
  existing API, worker, UI, crypto, glob, lint, type and build checks.
- Full web and sidecar audit gates passed with zero known vulnerabilities;
  Windows desktop dependency installation also reported zero.
- Windows build log: `Packaged web notices: collect passed` at 07:19:10 UTC.
- After ZIP relocation to a Unicode/space-containing directory, bundled Node
  verified the notice inventory hashes: `Packaged web notices: verify passed`
  at 07:34:41 UTC. Packaged native RSA adapter loading/encryption also passed.
- Two launches, Studio/API/worker readiness and key/database preservation passed.
- [First CPU six-stem job](windows-audio-37276579470.json): 19.67 seconds.
- [New offline CPU job](windows-offline-37276579470.json): 29.17 seconds, fresh
  profile with prepared model cache and outbound traffic blocked. Both jobs
  verified six FLAC files, hashes, duration, decoding and waveforms.
- [Offline packaged playback](windows-playback-37276579470.json): six controls,
  advancing playback, ended state and six export links passed. The network
  positive control was reachable before the firewall rules and blocked after.

The jobs use a generated four-second stereo signal. Times cover the acceptance
flow, not pure inference, and do not predict full-song performance or quality.

## Artifact identity

- [Artifact 11331052672](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37276579470/artifacts/11331052672):
  `musicscope-windows-desktop`, 571,657,052 bytes.
- GitHub-reported outer archive SHA-256:
  `5a3a302c73cbc4094825b59896263803943d528bbe635639bc30fe0a3b12ba45`.
- Included `MusicScope-0.1.0-beta.2-windows-x64.zip`: 581,938,144 bytes according
  to the artifact directory.
- [Included package checksum](windows-package-37276579470.zip.sha256):
  `ec048120a20de9ab95ea34102a64ff30797f4dee0c8edf98e25880868979f798`.

Reports and checksum were retrieved with HTTP ranges and entry CRCs checked by
Python's ZIP reader. Report line endings were normalized to LF. The new full
archive/package hashes were not independently recomputed locally. The complete
package checksum/CRC inspection recorded for run `37207233930` applies only to
that older artifact, not this candidate.

## Release status

The new automated checks pass. [Redistribution preparation](redistribution-2026-10-05.md)
still identifies unresolved corresponding-source/build materials and native
dependency review. [Manual Windows acceptance](windows-manual-acceptance.md)
requires a suitable machine; the user currently has none available. Keep the
[integration PR](https://github.com/sevenlemoon/MusicScope-V2/pull/1) in draft.
No beta.2 release or merge was performed. The publication workflow still requires
successful validation on `master` before using its exact tested artifact.
