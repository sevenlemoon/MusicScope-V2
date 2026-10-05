# Desktop redistribution preparation — 2026-10-05

Status: incomplete. Dependency vulnerability audits passed, but those audits do
not check redistribution materials. This record identifies inspected files and
concrete remaining work, without certifying overall license compliance.

## Web notices: packaging fix

Inspection of the earlier bundled Windows ZIP (run `36874048404`) found React
runtime code without its root LICENSE file. Next's standalone output traces
runtime dependencies and omits some non-runtime files; the current local
standalone build exhibits the same omission.

`scripts/desktop_web_notices.cjs` now restores notice files from the exact
installed source directories represented in the packaged web runtime. It checks
package names/versions, preserves notice bytes, includes notices for vendored
code and license subdirectories, and avoids unused development dependencies.
The build writes package metadata and notice SHA-256 values to
`resources/project/dependency-inventory/web-notices.json`. The relocated Windows
acceptance harness verifies this inventory with bundled Node.

Local verification: four regression cases passed (relocation and original notice
bytes, version mismatch, missing/changed notices, and inventory path traversal).
A copy of the actual macOS standalone output restored 61 notice files with 68
package metadata entries and passed verification. Windows must validate its own
new package; run `37207233930` predates this addition.

This inventory covers available notices for shipped web dependency directories.
It does not infer licenses for code without notice files or replace a review of
browser bundles, Python wheels, native libraries or the NetEase sidecar.

## FFmpeg: corresponding build materials remain unresolved

The pinned dependency in `scripts/ensure_ffmpeg.ps1` is Gyan's
`ffmpeg-9.0.2-essentials_build.zip`, SHA-256
`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`.
The inspected package includes FFmpeg's LICENSE and README; the README states
GPL v3 and identifies FFmpeg commit `946fcce07b`. It lists numerous statically
included external libraries. It does not contain their complete matching source
trees and build scripts.

[Gyan's build documentation](https://www.gyan.dev/ffmpeg/builds/) identifies its
builds as GPLv3 and lists the included libraries.
[FFmpeg's official license guidance](https://ffmpeg.org/legal.html) explains that
enabled GPL components change the applicable FFmpeg license and emphasizes
matching binary/source versions and build information. Do not describe this
binary as an LGPL-only build or treat a generic upstream homepage as proof that
all corresponding build materials have been supplied.

Before approving redistribution, identify the exact source revisions and build
materials for this binary and its included libraries, select and document an
appropriate source delivery route, and preserve the required notices. If those
materials cannot be obtained, replace it with a reproducible build whose sources
and build configuration are available, then rerun audio and package acceptance.
No project-wide license change or source-delivery promise has been made here.

## Other components and release provenance

The previously inspected package contains Electron/Chromium, Node and Python
license files and installed dependency metadata. Presence is evidence, not a
completed review of all bundled native code. Python requirement inventories
already retain resolved hashes; the new web inventory adds notice provenance.
Model weights are downloaded separately and are not shipped inside the ZIP.

The release workflow accepts successful `master` validation runs only. The
current candidate is validated on `codex/windows-bundled-runtime`; it must go
through integration and a successful validation run on `master` before the
existing publication workflow can use it. Preserve this provenance check.
Publication should use the exact tested artifact and its verified checksum.

See [manual Windows acceptance](windows-manual-acceptance.md) for the remaining
runtime, listening and real beta.1 upgrade evidence.
