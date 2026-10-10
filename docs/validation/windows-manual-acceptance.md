# Windows beta.2 manual acceptance

Use a disposable Windows 10/11 x64 VM or test PC. Record the exact candidate
commit, validation run, ZIP SHA-256, Windows version, account type and audio
device with the result. Do not mark an item passed without running it. Do not
include real account cookies, keys, private paths or copyrighted audio in reports.

## Clean installation and listening

1. Create a standard (non-administrator) Windows account with a Unicode username.
   Use a machine without separately installed Python, Node, uv or FFmpeg.
2. Download the candidate ZIP and checksum from the same successful validation
   run. Compare `Get-FileHash -Algorithm SHA256 <zip>` with the checksum before
   extracting to a folder containing Unicode and spaces.
3. Open `MusicScope.exe` normally. Confirm the Studio loads without requesting
   administrator access or dependency installation. Record any missing-DLL or
   startup error. First model preparation still needs network access.
4. Import a short music clip you are entitled to use through the Studio UI. Run
   CPU six-stem separation; record duration, model and completion status.
5. With speakers/headphones, listen to mixed playback and each of the six stems.
   Check first-play mute, solo, gain, seeking, looping, pause/resume and the ended
   state. Record audible glitches and separation quality separately from UI bugs.
6. Export through each of the six links and open the resulting files in another
   player. Confirm audible content, expected duration and successful decoding.
7. Close the app normally. Confirm owned background services exit. Disable the
   test machine's network, reopen the result, play it, then submit a new local
   file task using the prepared model cache. Restore networking afterwards.

## Real beta.1 binary upgrade

Use a second disposable VM snapshot/profile. Do not run this against your only
copy of an existing library, and do not downgrade a migrated library in place.

1. Download the published `v0.1.0-beta.1` asset from its GitHub release and verify
   its checksum. The older CI candidate also named beta.1 is a different binary;
   it is not suitable for this test.
2. Start beta.1 normally (not `--smoke-test`, which uses a different data path).
   Prepare a small library, playlist and completed local task. If testing account
   continuity, use a test account and record only whether it remains usable.
3. Close beta.1 and take a private VM snapshot or backup of
   `%APPDATA%/MusicScope/workspace`. Record the `.env` hash locally; never upload
   its contents. Preserve the existing app folder separately.
4. Extract beta.2 into a different application folder and open it normally under
   the same Windows account. Confirm the old library, playlists and task results
   remain accessible, existing account data can still be read, and a new task
   completes. Confirm the `.env` hash is unchanged.
5. Close and reopen beta.2 once more and repeat the persistence checks. Inspect
   schema-migration backup behavior if this candidate changes the schema.

## Result template

- Candidate commit / validation run / ZIP SHA-256:
- Windows version / standard account / Unicode account:
- No developer runtimes installed:
- Launch / missing DLLs / normal shutdown:
- Test clip permission and duration (no audio upload required):
- Six-stem job / listening / mute / solo / gain / seek / loop / ended state:
- Six exported files:
- Offline restart / new offline task:
- Published beta.1 checksum / upgrade data continuity / key unchanged:
- Failures and redacted diagnostics:

Store completed evidence with the candidate's validation records. An empty
template, CI on a hosted runner or a database fixture does not satisfy these
manual checks.
