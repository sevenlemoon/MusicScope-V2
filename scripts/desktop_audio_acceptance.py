"""Real CPU engine acceptance against an isolated local test instance, not a quality benchmark."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import time
import wave
from pathlib import Path
from urllib.parse import urlsplit

import httpx

STEMS = {"VOCALS", "DRUMS", "BASS", "GUITAR", "PIANO", "OTHER"}
DURATION_MS = 4000


def generate_audio(path: Path) -> None:
    """Deterministic synthetic signal: no personal or copyrighted recordings."""
    rate = 44100
    with wave.open(str(path), "wb") as output:
        output.setparams((2, 2, rate, 0, "NONE", "not compressed"))
        frames = bytearray()
        for index in range(rate * DURATION_MS // 1000):
            t = index / rate
            pulse = math.exp(-30 * (t % 0.5))
            value = int(6000 * (0.5 * math.sin(2 * math.pi * 220 * t)
                               + 0.25 * math.sin(2 * math.pi * 523.25 * t)
                               + 0.25 * pulse * math.sin(2 * math.pi * 65 * t)))
            frames.extend(struct.pack("<hh", value, value))
        output.writeframes(frames)


def check_artifacts(job: dict) -> None:
    artifacts = job["artifacts"]
    if len(artifacts) != 6 or {item["stem_type"] for item in artifacts} != STEMS:
        raise RuntimeError("Expected exactly six distinct stems")
    if job["device"] != "cpu" or job["model_name"] != "htdemucs_6s":
        raise RuntimeError("Acceptance must use the real CPU six-stem engine")
    for item in artifacts:
        if (abs(item["duration_ms"] - DURATION_MS) > 100
                or item["sample_rate"] != 44100 or item["channels"] != 2):
            raise RuntimeError("Stem duration/rate/channels failed synchronization validation")


def run_acceptance(base_url: str, output: Path, ffmpeg: Path, timeout: int = 1200) -> dict:
    url = urlsplit(base_url)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path not in {"", "/"}:
        raise ValueError("Acceptance only targets an explicitly isolated loopback API")
    output.mkdir(parents=True, exist_ok=True)
    source = output / "acceptance-generated.wav"
    generate_audio(source)
    started = time.monotonic()
    with httpx.Client(base_url=base_url, timeout=30, trust_env=False) as client:
        for _ in range(120):
            try:
                response = client.get("/health")
                if response.is_success and response.json().get("service") == "musicscope-v2-api":
                    break
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated API did not become ready")
        # Refuse a populated profile; this test must never submit jobs to a user's library.
        response = client.get("/api/v1/studio/jobs")
        response.raise_for_status()
        if response.json()["items"]:
            raise RuntimeError("Acceptance requires an empty, isolated job database")
        with source.open("rb") as audio:
            response = client.post("/api/v1/studio/assets", files={"file": (source.name, audio, "audio/wav")})
        response.raise_for_status()
        asset = response.json()
        response = client.post(f"/api/v1/studio/assets/{asset['id']}/jobs?model=htdemucs_6s")
        response.raise_for_status()
        job_id = response.json()["id"]
        previous_stage = None
        while time.monotonic() - started < timeout:
            response = client.get(f"/api/v1/studio/jobs/{job_id}")
            response.raise_for_status()
            job = response.json()
            if job["stage"] != previous_stage:
                previous_stage = job["stage"]
                print(f"Acceptance stage: {previous_stage}", flush=True)
            if job["status"] == "SUCCEEDED":
                break
            if job["status"] in {"FAILED", "CANCELLED"}:
                raise RuntimeError(f"Engine acceptance failed: {job['safe_error_code']}")
            time.sleep(1)
        else:
            raise RuntimeError("Real engine acceptance timed out")
        check_artifacts(job)
        for artifact in job["artifacts"]:
            response = client.get(artifact["stream_url"], params={"download": "true"})
            response.raise_for_status()
            if (not response.content.startswith(b"fLaC")
                    or len(response.content) != artifact["size_bytes"]
                    or hashlib.sha256(response.content).hexdigest() != artifact["sha256"]):
                raise RuntimeError("Downloaded FLAC failed integrity validation")
            target = output / f"{artifact['stem_type']}.flac"
            target.write_bytes(response.content)
            subprocess.run([str(ffmpeg), "-nostdin", "-v", "error", "-xerror", "-i", str(target),
                            "-f", "null", "-"], check=True, capture_output=True, timeout=30)
        response = client.get(job["waveform_url"])
        response.raise_for_status()
        if set(response.json()["stems"]) != STEMS:
            raise RuntimeError("Six-stem waveform is incomplete")
        report = {"status": "passed", "job_id": job_id, "model": job["model_name"], "device": job["device"],
                  "stems": sorted(STEMS), "input_duration_ms": DURATION_MS,
                  "download_integrity": True, "flac_decode": True, "waveforms": True,
                  "elapsed_seconds": round(time.monotonic() - started, 2),
                  "quality_benchmark": False, "speaker_playback_test": False}
        (output / "audio-acceptance.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--isolated-test-instance", action="store_true", required=True)
    args = parser.parse_args()
    print(json.dumps(run_acceptance(args.api_url, args.output, args.ffmpeg)))
