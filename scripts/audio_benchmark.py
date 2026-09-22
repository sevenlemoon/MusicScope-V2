#!/usr/bin/env python3
"""Run a bounded Demucs four-stem feasibility benchmark on a local audio file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


EXPECTED_STEMS = frozenset({"vocals", "drums", "bass", "other"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark real four-stem Demucs separation without touching MusicScope data."
    )
    parser.add_argument("input", type=Path, help="Local user-owned or project-safe audio file.")
    parser.add_argument(
        "--demucs-python",
        type=Path,
        default=Path(sys.executable),
        help="Python interpreter from an isolated environment containing Demucs.",
    )
    parser.add_argument("--device", choices=("mps", "cpu"), default="cpu")
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--segment", type=int, default=7)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--max-input-bytes", type=int, default=200 * 1024 * 1024)
    parser.add_argument("--max-duration-seconds", type=float, default=15 * 60)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--flac", action="store_true", help="Request lossless FLAC stems.")
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=duration,size,format_name:stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    payload = json.loads(completed.stdout)
    streams = payload.get("streams") or []
    if len(streams) != 1:
        raise ValueError("Expected exactly one decodable audio stream.")
    return {"stream": streams[0], "format": payload.get("format") or {}}


def memory_bytes(raw_max_rss: int) -> int:
    # getrusage reports bytes on macOS and KiB on Linux.
    return raw_max_rss if platform.system() == "Darwin" else raw_max_rss * 1024


def find_stems(output_dir: Path) -> dict[str, Path]:
    stems = {
        candidate.stem.casefold(): candidate
        for candidate in output_dir.rglob("*")
        if candidate.is_file() and candidate.suffix.casefold() in {".wav", ".flac"}
    }
    if frozenset(stems) != EXPECTED_STEMS:
        raise RuntimeError(f"Expected four stems {sorted(EXPECTED_STEMS)}, got {sorted(stems)}.")
    return stems


def worker_versions(demucs_python: Path) -> dict[str, str]:
    code = (
        "import importlib.metadata as m,json,torch;"
        "print(json.dumps({'demucs':m.version('demucs'),'torch':torch.__version__}))"
    )
    completed = subprocess.run(
        [str(demucs_python), "-c", code],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(completed.stdout)


def run_demucs(command: list[str], timeout_seconds: int) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise RuntimeError("Demucs exceeded the benchmark timeout.") from exc
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def benchmark(args: argparse.Namespace, output_dir: Path) -> dict[str, Any]:
    candidate = args.input.expanduser()
    if candidate.is_symlink():
        raise ValueError("Input symlinks are not accepted.")
    source = candidate.resolve(strict=True)
    if not source.is_file():
        raise ValueError("Input must be a regular file.")
    if source.stat().st_size > args.max_input_bytes:
        raise ValueError("Input exceeds the configured benchmark size limit.")
    demucs_python = args.demucs_python.expanduser()
    if not demucs_python.is_absolute():
        demucs_python = Path.cwd() / demucs_python
    if not demucs_python.exists():
        raise ValueError("Demucs Python interpreter does not exist.")
    source_probe = probe(source)
    duration_seconds = float(source_probe["format"]["duration"])
    if duration_seconds <= 0:
        raise ValueError("Input duration must be positive.")
    if duration_seconds > args.max_duration_seconds:
        raise ValueError("Input exceeds the configured benchmark duration limit.")

    command = [
        str(demucs_python),
        "-m",
        "demucs",
        "-n",
        args.model,
        "-d",
        args.device,
        "--segment",
        str(args.segment),
        "--overlap",
        str(args.overlap),
        "--shifts",
        str(args.shifts),
        "-j",
        "0",
        "-o",
        str(output_dir),
    ]
    if args.flac:
        command.append("--flac")
    command.append(str(source))

    started = time.monotonic()
    completed = run_demucs(command, args.timeout_seconds)
    elapsed = time.monotonic() - started
    if completed.returncode != 0:
        diagnostic = (completed.stderr or completed.stdout)[-2000:]
        raise RuntimeError(f"Demucs failed with exit code {completed.returncode}: {diagnostic}")

    stems = find_stems(output_dir)
    artifacts: dict[str, Any] = {}
    for stem_name, stem_path in sorted(stems.items()):
        stem_probe = probe(stem_path)
        stem_duration = float(stem_probe["format"]["duration"])
        if abs(stem_duration - duration_seconds) > 0.1:
            raise RuntimeError(f"{stem_name} duration differs from the source by more than 100 ms.")
        artifacts[stem_name] = {
            "bytes": stem_path.stat().st_size,
            "sha256": sha256(stem_path),
            "duration_seconds": stem_duration,
            "codec": stem_probe["stream"].get("codec_name"),
            "sample_rate": int(stem_probe["stream"]["sample_rate"]),
            "channels": int(stem_probe["stream"]["channels"]),
        }

    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "source": {
            "filename": source.name,
            "bytes": source.stat().st_size,
            "sha256": sha256(source),
            "duration_seconds": duration_seconds,
            "codec": source_probe["stream"].get("codec_name"),
            "sample_rate": int(source_probe["stream"]["sample_rate"]),
            "channels": int(source_probe["stream"]["channels"]),
        },
        "separation": {
            "model": args.model,
            "runtime_versions": worker_versions(demucs_python),
            "device": args.device,
            "segment_seconds": args.segment,
            "overlap": args.overlap,
            "shifts": args.shifts,
            "wall_seconds": round(elapsed, 3),
            "real_time_factor": round(elapsed / duration_seconds, 4),
            "peak_child_rss_bytes": memory_bytes(usage.ru_maxrss),
            "artifact_format": "flac" if args.flac else "wav",
        },
        "artifacts": artifacts,
        "artifact_total_bytes": sum(value["bytes"] for value in artifacts.values()),
    }


def main() -> int:
    args = parse_args()
    if shutil.which("ffprobe") is None:
        raise SystemExit("ffprobe is required on PATH.")
    if args.output_dir is not None:
        output_candidate = args.output_dir.expanduser()
        if output_candidate.is_symlink():
            raise SystemExit("Output directory symlinks are not accepted.")
        output_dir = output_candidate.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        if not output_dir.is_dir():
            raise SystemExit("Output path must be a directory.")
        report = benchmark(args, output_dir)
        report["output_retained"] = True
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    with tempfile.TemporaryDirectory(prefix="musicscope-audio-benchmark-") as temporary:
        report = benchmark(args, Path(temporary))
        report["output_retained"] = False
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
