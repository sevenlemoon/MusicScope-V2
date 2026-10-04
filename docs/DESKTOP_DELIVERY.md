# Desktop delivery: production runtime (validated candidate, unreleased)

This describes the **unreleased beta.2** production delivery path. The published
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
- Demucs weights are **not bundled**. First separation still needs model
  download connectivity. Preparation now has a separate deadline, bounded network
  timeouts, range retry and checksum verification; inference uses the verified
  local repository. This is not a fully offline installation.
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
The model cache is isolated and needs a first download. The beta.2 harness then
blocks non-loopback outbound traffic for the packaged executables on the disposable
Windows runner, verifies a network control probe, reopens the first result through
Electron's player and runs a second real job in a fresh profile using the prepared
cache. Firewall rules/profile settings are restored afterwards. Reports are emitted
only on success. This is real model
execution, **not** a musical-quality or speaker-playback test, and does not
simulate a completely clean Windows installation. Test audio is not published.

Release acceptance status (reviewed 2026-10-04):

1. **Passed:** Windows package build, relocation to a Unicode/space-containing
   application path, two launches, Studio/API/worker readiness, key/database
   preservation, and real CPU six-stem execution on a generated signal. See
   [the verified Windows evidence](validation/windows-desktop-2026-10-01.md).
   The isolated user profile contains spaces; a real Unicode Windows account
   has not been tested.
2. **Pending:** clean Windows VM without installed runtimes; inspect missing
   native DLLs. Removing developer tools from PATH on a hosted runner is not
   equivalent to removing installed software or running as a standard user.
3. **Pending:** playback and export through the packaged UI on a licensed music
   clip, including listening to the result. API downloads and FFmpeg decoding
   passed; they do not prove speaker playback or musical quality.
4. **Partially verified:** Mac offline restart and a new real CPU job passed;
   model-download truncation/resume/checksum/disk-full tests passed, as did upload
   disk-full recovery and database/key preservation fixtures. See
   [Mac evidence](MAC_STARTUP.md). Windows offline packaged playback/inference
   passed at `550a423`; see [Windows evidence](validation/windows-desktop-2026-10-04.md).
   The later dependency patch revision needs its own validation. A real beta.1 binary upgrade with
   existing user data remains pending; database fixtures do not establish it.
5. **In progress:** beta.2 has a distinct version and the release workflow derives
   filenames and notes from the validated commit. It requires audio, offline and
   playback reports. A successful new Windows run and redistribution review are
   still required; the earlier beta.1 candidate is historical evidence only.
6. **Locally resolved:** the affected node-forge and braces dependency chains
   have been replaced; full web, sidecar and desktop npm audits report zero known
   vulnerabilities. Regression and audit gates remain enabled. The new Windows
   build must validate the physical RSA adapter after relocation. See
   [the audit record](validation/dependency-audit-2026-10-04.md).

## macOS startup

`MusicScope.command` now opens the local SQLite production path described in
[MAC_STARTUP.md](MAC_STARTUP.md). The old PostgreSQL launcher remains available
with `--legacy-docker`; its database and account identity are not migrated or
deleted. Source-based setup is still required on macOS; this is not a signed app.

Developer source launchers remain supported separately. Do not remove legacy
database migrations or user storage as part of package cleanup.

## Local evidence (2026-10-01)

The generated four-second signal completed the real `htdemucs_6s` CPU path on
macOS in 16.72 seconds, using an isolated SQLite database and the existing model
cache. All six downloads passed SHA-256, duration, decoding and waveform checks.
This does not establish first-download reliability, music quality, sound-device
playback, or Windows package compatibility. Subsequent Windows build/relocation
and generated-signal CPU acceptance passed on 2026-10-01 (verified on 2026-10-04);
no updated release has been published.
