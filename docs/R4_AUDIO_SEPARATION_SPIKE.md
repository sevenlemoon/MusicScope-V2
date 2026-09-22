# R4.0 real four-stem audio separation spike

## Decision

Real four-stem separation is feasible on the target Apple Silicon machine. MusicScope should run
Demucs in an isolated local worker environment, not inside the FastAPI process. The measured default
device is Apple MPS with a recorded, explicit CPU fallback. The worker should execute one job at a
time through an owned subprocess and persist state in PostgreSQL.

The tested package path is `demucs==4.1.0` from the `adefossez/demucs` project, with
`torch==2.14.0` and an explicit `numpy==1.26.4` dependency. Demucs 4.1.0 omits NumPy from its
macOS arm64 runtime dependency metadata even though its transformer imports NumPy, so the future
worker lock must include the explicit pin.

## Measured machine inventory

- macOS 15.7.4 (24G517), arm64
- Apple M1 Pro, 8 CPU cores (6 performance, 2 efficiency), 16 GB unified memory
- approximately 85 GiB free on the relevant volume during the spike
- project API Python 3.12.14; additional installed Python 3.13.3 and system Python 3.9.6
- current shell Node.js 20.18.0; the web project remains pinned to Node.js 24.21+
- FFmpeg and ffprobe 9.0.1 from `/opt/homebrew/bin`
- API environment contained neither Torch nor Demucs before and after the spike
- isolated spike: Python 3.12.14, Demucs 4.1.0, Torch 2.14.0, NumPy 1.26.4
- Torch reports MPS built and available; CUDA is unavailable

## Test input and formats

No project-owned real music sample was present. The spike used a generated, lawful 44.1 kHz stereo
mixture containing bass, pitched, modulated, and percussive/noise components. This proves the real
pipeline and artifact behavior but does not replace subjective separation-quality QA on a legitimate
user-owned recording in R4.1.

Demucs successfully decoded and separated all proposed MVP inputs on this machine:

- WAV / PCM signed 16-bit
- MP3
- FLAC
- M4A / AAC

The 20-second source was encoded in all four formats and each format completed real `htdemucs`
separation. Uploads must still be verified with ffprobe; extension and MIME type are advisory only.

## Real separation measurements

All runs used `htdemucs`, four stems, segment 7, overlap 0.25, and worker jobs 0. Model download
time is separated from warm inference.

| Source | Device | Cache | Wall time | RTF | Maximum RSS | Peak footprint |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 20 s WAV | MPS | cold | 40.74 s | 2.037 | 0.88 GB | 1.84 GB |
| 20 s WAV | MPS | warm | 5.28 s | 0.264 | 0.98 GB | 1.83 GB |
| 20 s WAV | CPU | warm | 12.14 s | 0.607 | 1.66 GB | 0.72 GB |
| 180 s MP3 | MPS | warm | 18.78 s | 0.104 | 1.53 GB | 2.43 GB |

The cold MPS measurement includes the first model download. MPS was reliable in every real run and
was approximately 2.3 times faster than CPU for the comparable 20-second workload. MPS is therefore
the local default. CPU remains a configured retry choice, not an unrecorded automatic replay after an
arbitrary failure.

The 180-second result produced exactly `vocals`, `drums`, `bass`, and `other`. Every artifact decoded
without error and was 44.1 kHz, stereo, signed 16-bit PCM. All four durations were 180.036 seconds,
35.9 ms longer than the compressed source and mutually identical. The four WAV files totaled 121 MiB
from a 4.32 MB MP3.

The 20-second FLAC-output run also succeeded. Its four artifacts totaled 3.6 MiB versus 13 MiB for
WAV on this synthetic input. Compression ratios for real music will be lower, but a single lossless
FLAC artifact set is the recommended MVP format; avoid maintaining redundant WAV and playback copies.

## Model cache

Demucs 4.1.0 obtains `htdemucs` from Hugging Face. With `HF_HOME` explicitly isolated, the model
cache occupied 87 MiB and contained one approximately 80 MiB weight blob. The warm runs reused it
without downloading model bytes. R4.1 should configure a stable external cache such as
`~/Library/Caches/MusicScope/models`, retain weights across jobs, and never place them under Git.

The isolated Python environment occupied approximately 689 MiB. This is another reason to keep Torch
out of the API environment.

## Processing boundary

Recommended local flow:

```text
FastAPI upload/metadata API
  -> PostgreSQL AudioAsset + StemJob(QUEUED)
  -> durable local worker poll/claim loop
  -> owned Demucs CLI subprocess from isolated uv environment
  -> validate and atomically publish four artifacts + waveform
  -> StemJob(SUCCEEDED)
```

Use a small worker process launched by the one-command development script. PostgreSQL is sufficient
for the durable queue; Redis and Celery are unnecessary for a single-machine graduation project. The
worker claims one queued job transactionally, records a worker-run identifier and heartbeat, and
executes the isolated CLI with an argument array and a controlled environment.

CLI subprocess integration is preferred over importing Demucs into FastAPI because it provides
dependency isolation, crash and memory containment, owned-process cancellation, bounded stderr,
and explicit exit status. It also prevents Torch initialization from increasing every API process.

## Input preparation

Preserve the original upload unchanged. Stream it to a newly created asset directory while computing
SHA-256; never buffer the whole file in memory. Probe the completed file with ffprobe, enforce limits,
and reject unsupported or ambiguous streams.

For R4.1, transcode a temporary canonical processing input with FFmpeg:

- 44.1 kHz
- stereo
- PCM signed 16-bit WAV
- no loudness normalization
- argument-array invocation, controlled destination, timeout, and bounded stderr

This costs about 31.8 MB for a three-minute input and provides deterministic decoding before the
expensive model step. Delete it after success, failure, or cancellation. Demucs direct decoding is
proven for all MVP formats and remains a possible later optimization.

Recommended initial limits are 200 MB and 15 minutes, one audio stream, and the tested codecs above.
A 15-minute canonical 44.1 kHz stereo PCM input is about 159 MB; four uncompressed stems would be
about 635 MB. These limits keep a single job below a practical local-gigabyte storage envelope while
covering ordinary songs and extended mixes.

## Runtime storage

Use the already ignored configured root `storage/audio`, with server-generated UUID components only:

```text
storage/audio/
  assets/<asset-id>/original/source.<verified-extension>
  jobs/<job-id>/processing/input.wav
  jobs/<job-id>/stems/{vocals,drums,bass,other}.flac
  jobs/<job-id>/waveform/peaks-v1.json
  jobs/<job-id>/metadata/result-v1.json
  jobs/<job-id>/tmp/<worker-run-id>/
```

Resolve every path from an ID and trusted database storage key. Reject absolute keys, `..`, symlinks,
and any resolved path outside the storage root. PostgreSQL stores metadata and storage keys, never
audio bytes or model weights. Publish by renaming a completed same-filesystem temporary directory.

Failed/cancelled job temporary directories are deleted. A startup sweeper removes expired orphan
temporary directories only after proving that no active worker owns them. Completed artifacts remain
until an explicit user-scoped deletion. Model weights use their own retained cache.

## Domain changes for R4.1

The SQLAlchemy models and live database already contain `AudioAsset`, `StemJob`, and `StemArtifact`.
They entered the schema through the R0 `0001` metadata bootstrap; the live columns match the current
placeholder models. R4.1 should add an explicit additive/altering migration `0007` for the fields and
status transition below, with safe defaults and backfill. R4.0 does not create a migration.

`AudioAsset` needs the existing owner, name, storage key, SHA-256, duration and metadata plus explicit
media type, byte size, sample rate, and channels. A user-scoped checksum index supports reuse without
making one user's asset visible to another.

`StemJob` should use `QUEUED`, `PREPARING`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED` rather
than the placeholder status set. Add device, stage, error code, retry count, worker-run identifier,
heartbeat, cancellation-requested timestamp, and completed timestamps. `safe_error_message` is public;
raw bounded diagnostics remain backend-only.

`StemArtifact` already enforces one artifact per `(job, stem_type)`. Add media type, byte size, sample
rate, channels, and artifact configuration/version. Ownership is always derived and checked through
`StemJob.user_id`; all job, artifact, waveform, and media routes require that owner predicate.

## Idempotency

Use streaming SHA-256 for the original bytes. The deterministic separation fingerprint is SHA-256 of
a versioned canonical JSON document containing:

```text
source SHA-256
model name + weight/release identity
Demucs package version
canonical input configuration
device-independent separation configuration
artifact format/version
waveform format/version
```

Device is execution metadata, not part of the logical artifact identity, unless measured output
reproducibility later requires it. Reuse only a `SUCCEEDED` user-owned job whose four artifacts still
exist and pass metadata validation. Filename is never identity.

The measured default `shifts=1` path is stochastic: repeated successful runs can produce different
artifact hashes even with the same source, model, device, segment, and overlap. The deterministic key
therefore identifies a logical processing request and must reuse its first validated success; it does
not promise byte-identical regeneration. Record `shifts` in the configuration. If byte reproducibility
becomes a requirement, R4.1 must separately evaluate a fixed seed or `shifts=0` and its quality tradeoff.

## Playback and mixing

Use four streaming `HTMLMediaElement`s, each wrapped by `MediaElementAudioSourceNode -> GainNode`, then
connect all tracks to a master `GainNode`. One primary element is the transport clock. Play/pause and
seek operate on all four elements, and a low-frequency drift monitor corrects material divergence.

A real browser test served the four WAV stems through HTTP Range responses. Maximum observed drift
was 0.286 ms during six seconds of common playback and 0.384 ms after a coordinated seek to 10 seconds;
all four requests used HTTP 206 and the console had no errors. Longer-track QA is still required, so
the drift monitor must remain.

Fully decoded `AudioBuffer`s require roughly `duration * 44,100 * 2 channels * 4 bytes * 4 stems`:
about 254 MB for three minutes and 423 MB for five minutes, before browser overhead. Streaming media
elements therefore provide the safer long-track MVP.

Gain, mute, and solo are real-time Web Audio gain changes. Effective gain is zero when muted or when
another track is soloed; otherwise it is the user's per-track gain multiplied by master gain. These
controls never invoke separation or modify artifacts.

## Waveform

Generate real peaks in the worker after separation. Decode each stem sequentially and create signed
min/max pairs for 2,000 buckets per stem, normalized to `[-1, 1]`. A JSON v1 payload with four stems
contains about 16,000 numeric values and should normally remain below roughly 150 KiB. Include duration,
sample rate, bucket count, and format version. One resolution is sufficient for R4.1; add tiles or
multiple resolutions only when real zoom behavior requires them.

The UI uses the shared timeline for seeking and overlays or vertically stacks deterministic stem peak
data. It never generates random/decorative waveform values.

## Audio serving and Range behavior

FastAPI should serve user-scoped artifacts by artifact ID. After ownership and storage-root checks,
return Starlette `FileResponse` with an allowlisted media type, safe download name, `ETag`,
`Cache-Control: private`, and `X-Content-Type-Options: nosniff`. Never expose a filesystem path or
accept one from the client.

The installed FastAPI/Starlette stack was tested with the sample audio: a normal request returned 200
with `Accept-Ranges: bytes`; `Range: bytes=100-199` returned 206, a correct `Content-Range`, and exactly
100 bytes; an unsatisfiable range returned 416. The transient browser harness also received four 206
responses while playing and seeking.

## Progress, cancellation, and recovery

Expose honest stages rather than fabricated smooth progress:

```text
QUEUED -> PREPARING/probing -> PREPARING/transcoding
       -> RUNNING/loading_model -> RUNNING/separating
       -> RUNNING/writing_artifacts -> RUNNING/generating_waveform
       -> SUCCEEDED
```

Demucs emits segment progress, but its textual CLI output is not a stable API. R4.1 may parse it as
best-effort diagnostic progress while the public contract remains stage-based.

Cancellation sets a database request flag. The worker sends SIGTERM only to the owned process group,
waits a bounded grace period, then SIGKILLs that same group if needed. It deletes only the job's
temporary directory and marks `CANCELLED`. Never kill by process name.

On worker startup, any prior `PREPARING` or `RUNNING` job with an expired heartbeat becomes `FAILED`
with `WORKER_INTERRUPTED`; the user may retry it. Do not silently replay a possibly expensive job.
Retries create or increment a recorded attempt and reuse only fully validated successful artifacts.

## Concurrency and device selection

Maximum separation concurrency is one. The measured peak footprint reached 2.43 GB on a 16 GB machine,
and concurrent Torch workers would multiply model and working memory. Other queued jobs remain durable.

Device selection is: explicit configured override, otherwise validated MPS, otherwise CPU. Record the
chosen device before execution. CPU fallback after an MPS-specific failure requires a recorded retry
decision and must not happen invisibly in the same attempt.

## Stable failure codes

- `UNSUPPORTED_AUDIO`
- `INVALID_AUDIO`
- `UPLOAD_TOO_LARGE`
- `DURATION_TOO_LONG`
- `FFPROBE_FAILED`
- `TRANSCODE_FAILED`
- `MODEL_UNAVAILABLE`
- `MODEL_LOAD_FAILED`
- `SEPARATION_FAILED`
- `OUT_OF_MEMORY`
- `PROCESS_CANCELLED`
- `WORKER_INTERRUPTED`
- `ARTIFACT_VALIDATION_FAILED`
- `ARTIFACT_WRITE_FAILED`

Public messages are bounded and safe. Raw tracebacks, full subprocess environments, credentials,
private paths, provider sessions, and user audio content are never returned to the frontend or written
to ordinary logs.

## Security boundary

- Local user upload only; provider playback URLs remain playback-only and are never processing input.
- Stream upload to a server-created file with size enforcement and SHA-256.
- Treat filename and MIME type as display hints; use ffprobe for actual validation.
- Reject path traversal, absolute storage keys, symlinks, non-regular files, multiple/unexpected streams,
  unsupported codecs, oversized files, overlong duration, and non-finite probe values.
- Invoke FFmpeg, ffprobe, and Demucs with argument arrays and no shell.
- Use controlled input/output roots, minimal child environment, timeouts, process groups, bounded logs,
  and atomic artifact publication.
- Require user ownership on every asset/job/artifact lookup and media/Range response.
- Use concurrency one and enforce storage quotas to contain decompression and resource exhaustion.
- Keep model/cache directories outside upload/artifact roots and non-writable by user-controlled paths.

## R4.1 implementation boundary

R4.1 should implement the isolated worker package/lock, migration 0007, upload and job APIs, user-scoped
artifact serving, durable single-job worker, real FLAC stems, waveform peaks, reopenable
`/studio/jobs/<job-id>`, and the streaming Web Audio mixer. It should include legitimate user-owned
music quality QA, long-duration browser drift testing, restart/cancel/retry integration tests, storage
quota enforcement, and responsive Studio UI.

R4.0 does not add a migration, API route, worker service, or Studio product implementation.
