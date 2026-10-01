import importlib.util
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "audio_acceptance", ROOT / "scripts/desktop_audio_acceptance.py",
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def valid_job():
    return {"device": "cpu", "model_name": "htdemucs_6s", "artifacts": [
        {"stem_type": stem, "duration_ms": 4000, "sample_rate": 44100, "channels": 2}
        for stem in sorted(module.STEMS)
    ]}


def test_generated_signal_is_deterministic_stereo_audio(tmp_path):
    first, second = tmp_path / "a.wav", tmp_path / "b.wav"
    module.generate_audio(first)
    module.generate_audio(second)
    assert first.read_bytes() == second.read_bytes()
    with wave.open(str(first)) as source:
        assert source.getnchannels() == 2
        assert source.getframerate() == 44100
        assert source.getnframes() == 4 * 44100


def test_acceptance_requires_all_six_distinct_outputs():
    job = valid_job()
    module.check_artifacts(job)
    job["artifacts"][0]["stem_type"] = job["artifacts"][1]["stem_type"]
    with pytest.raises(RuntimeError, match="six distinct"):
        module.check_artifacts(job)


@pytest.mark.parametrize("field,value", [("duration_ms", 4400), ("sample_rate", 22050), ("channels", 1)])
def test_acceptance_rejects_misaligned_outputs(field, value):
    job = valid_job()
    job["artifacts"][0][field] = value
    with pytest.raises(RuntimeError, match="synchronization"):
        module.check_artifacts(job)


def test_acceptance_rejects_external_api_before_writing_files(tmp_path):
    output = tmp_path / "output"
    with pytest.raises(ValueError, match="loopback"):
        module.run_acceptance("https://example.com", output, Path("ffmpeg"))
    assert not output.exists()
