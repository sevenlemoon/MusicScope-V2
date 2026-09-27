"""Conservative beat-grid estimate from a separated drum stem.

This is a steady-tempo aid for the mixer, not a time-signature or score
transcription. Return None instead of inventing a tempo for weak or drifting
material.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 4000
HOP_SAMPLES = 40  # 10 ms at the waveform decoder's sample rate.
MIN_DURATION_SECONDS = 8
MIN_BPM = 60
MAX_BPM = 180


def estimate_beat_grid(samples: np.ndarray, duration_ms: int) -> dict[str, object] | None:
    if duration_ms < MIN_DURATION_SECONDS * 1000 or samples.size < MIN_DURATION_SECONDS * SAMPLE_RATE:
        return None
    count = samples.size // HOP_SAMPLES
    frames = samples[: count * HOP_SAMPLES].reshape(count, HOP_SAMPLES)
    energy = np.sqrt(np.mean(np.square(frames.astype(np.float64)), axis=1))
    if not np.isfinite(energy).all() or float(np.max(energy)) < 0.002:
        return None

    # Log compression makes an occasional loud hit less dominant than the pulse.
    envelope = np.log1p(energy * 50)
    onset = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    positive = onset[onset > 0]
    if positive.size < 8:
        return None
    onset = np.where(onset >= np.quantile(positive, 0.75), onset, 0)
    if np.count_nonzero(onset) < 8:
        return None

    hop_seconds = HOP_SAMPLES / SAMPLE_RATE
    minimum_lag = round(60 / (MAX_BPM * hop_seconds))
    maximum_lag = round(60 / (MIN_BPM * hop_seconds))
    best_lag = 0
    best_score = 0.0
    for lag in range(minimum_lag, maximum_lag + 1):
        left, right = onset[:-lag], onset[lag:]
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
        score = float(np.dot(left, right) / denominator) if denominator else 0.0
        # A half-tempo grid should not win a numerical tie against the pulse.
        score *= 1 - lag / (2 * count)
        if score > best_score:
            best_lag, best_score = lag, score
    if best_lag == 0 or best_score < 0.18:
        return None

    phase_energy = np.bincount(np.arange(count) % best_lag, weights=onset, minlength=best_lag)
    smoothed = sum(np.roll(phase_energy, shift) for shift in (-2, -1, 0, 1, 2))
    if float(np.max(smoothed) / max(float(np.sum(onset)), 1e-9)) < 0.16:
        return None
    phase = int(np.argmax(smoothed))
    interval_ms = best_lag * hop_seconds * 1000
    beats_ms = [round(value) for value in np.arange(phase * hop_seconds * 1000, duration_ms, interval_ms)]
    if len(beats_ms) < 8:
        return None
    return {
        "bpm": round(60 / (best_lag * hop_seconds)),
        "beats_ms": beats_ms,
        "source": "drums",
        "method": "onset-autocorrelation-v1",
    }
