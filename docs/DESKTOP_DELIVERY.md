# Desktop delivery: production runtime (in development)

This describes the **unreleased** production delivery path. The published
`v0.1.0-beta.1` still bootstraps dependencies on first launch; do not describe that
existing download as an offline-ready package.

## Build vs. launch

- Build on Windows x64 with the checked-in dependency locks. Install build
  dependencies, then run `scripts/build_desktop.ps1`.
- The builder compiles Next.js standalone output, installs production-only Python
  dependencies into private CPython 3.12.10, and bundles Node, FFmpeg/ffprobe and the
  NetEase sidecar. Dependency inventories and bundled dependency licenses remain
  in the package. This increases download and disk size; measure before publishing.
- Launch runs those bundled executables directly. No PowerShell development
  launcher, npm, uv, Docker, WSL, or dependency installation is invoked.
- Demucs weights are **not yet bundled**. First separation still needs model
  download connectivity. This is not a fully offline separation release.
- No installer/signing/automatic updater is introduced in this change. The
  portable ZIP remains the delivery format until packaging acceptance succeeds.

## Data compatibility and failure boundaries

- Code stays in the extracted application; private state stays under
  `%APPDATA%/MusicScope/workspace`, preserving the previous desktop data location.
- Startup does not copy source over existing data. Existing `.env` keys are never
  replaced. A library without its encryption key is rejected, not reset.
- SQLite is backed up before a schema-version change. Automatic rollback of
  migrations is not implemented; do not downgrade against migrated data blindly.
- API and web ports remain 8100 and 3100. Conflicts fail explicitly rather than
  reusing/killing an unknown service. The account sidecar uses a free local port;
  its failure does not stop local-file separation.
- Closing a ready application asks for confirmation and stops owned processes.
  Interrupted separation can be retried, not resumed from an intermediate sample.
- Runtime failures return to the diagnostic view instead of leaving a dead Studio
  screen. Logs remain private; inspect/redact before sharing.

## Release acceptance

`scripts/test_desktop_package.ps1` extracts the ZIP to a different path with
Unicode and spaces, isolates the user profile, removes developer tools from PATH,
and opens it twice through the normal production path. It checks Studio DOM,
the job API, worker readiness, and preservation of the key/database. It captures
the actual packaged UI. With `-Separate` (enabled in CI), it then runs the bundled
CPU worker against a generated four-second stereo signal in the isolated profile,
checks six distinct stems, download hashes, durations, FLAC decoding and waveforms.
The model cache is isolated and may need a first download. This is real model
execution, **not** a musical-quality or speaker-playback test, and does not
simulate a completely clean Windows installation. Test audio is not published.

Before publishing a new version, still require:

1. Successful Windows package build and relocation acceptance.
2. Clean Windows VM without installed runtimes; inspect missing native DLLs.
3. Real CPU six-stem separation, playback and export on a licensed test clip.
4. Offline restart after preparation, model-download failure, disk-space failure,
   and upgrade from beta.1 with existing data.
5. A new version/tag, measured package size, and verified redistribution notices.

Developer source launchers remain supported separately. Do not remove legacy
database migrations or user storage as part of package cleanup.

## Local evidence (2026-10-01)

The generated four-second signal completed the real `htdemucs_6s` CPU path on
macOS in 16.72 seconds, using an isolated SQLite database and the existing model
cache. All six downloads passed SHA-256, duration, decoding and waveform checks.
This does not establish first-download reliability, music quality, sound-device
playback, or Windows package compatibility. Windows build/relocation acceptance
remains pending; no updated release has been published.
