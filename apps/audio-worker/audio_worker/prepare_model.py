"""Prepare pinned Demucs weights separately from inference; a ready repo is offline."""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path

# Filenames/checksum prefixes from the locked Demucs distribution's remote/files.txt.
MODELS = {"htdemucs": "955717e8-8726e21a.th", "htdemucs_6s": "5c90dfd2-34c22ccb.th"}
BASE_URL = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/"


def valid_file(path: Path, checksum: str) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest().startswith(checksum)


def download(url: str, target: Path, checksum: str) -> None:
    partial = target.with_suffix(".part")
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                if response.status == 206:
                    match = re.fullmatch(
                        r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""),
                    )
                    if not match or int(match[1]) != offset:
                        raise RuntimeError("Model download returned an invalid byte range")
                    total = int(match[3])
                elif response.status == 200:
                    offset = 0  # Server ignored Range; restart instead of appending corrupt data.
                    total = int(response.headers.get("Content-Length", "0"))
                else:
                    raise RuntimeError("Model download returned an unexpected status")
                if total <= 0 or total > 1024**3 or total < offset:
                    raise RuntimeError("Model download size is invalid")
                if shutil.disk_usage(target.parent).free < total - offset + 8 * 1024**2:
                    raise OSError(28, "Not enough disk space for the model")
                count = offset
                with partial.open("ab" if offset else "wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        count += len(chunk)
                        if count > total:
                            raise RuntimeError("Model download exceeds the advertised size")
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                if count != total:
                    raise OSError("Model download was interrupted")
            if not valid_file(partial, checksum):
                partial.unlink(missing_ok=True)
                raise RuntimeError("Model download checksum mismatch")
            partial.replace(target)
            return
        except urllib.error.HTTPError as error:
            if error.code == 416:
                # An interrupted response may already have written the complete file.
                if valid_file(partial, checksum):
                    partial.replace(target)
                    return
                partial.unlink(missing_ok=True)
            if attempt == 2:
                raise RuntimeError("Model download failed; retry when connectivity is restored") from error
        except (OSError, urllib.error.URLError) as error:
            if getattr(error, "errno", None) == 28:
                raise
            if attempt == 2:
                raise RuntimeError("Model download failed; partial data was kept for retry") from error
        time.sleep(attempt + 1)


def prepare(name: str, cache: Path) -> Path:
    if name not in MODELS:
        raise ValueError("Unsupported model")
    filename = MODELS[name]
    signature, checksum = Path(filename).stem.split("-")
    repo = cache / "demucs-local"
    repo.mkdir(parents=True, exist_ok=True)
    target = repo / filename
    if not valid_file(target, checksum):
        # Reuse pre-existing Torch weights when valid. Never remove an old cache.
        previous = cache / "torch/hub/checkpoints" / filename
        if valid_file(previous, checksum):
            partial = target.with_suffix(".part")
            shutil.copyfile(previous, partial)
            partial.replace(target)
        else:
            print(f"Preparing model {name}; downloading verified weights", flush=True)
            download(BASE_URL + filename, target, checksum)
    config = repo / f"{name}.yaml"
    contents = f"models: ['{signature}']\n"
    if not config.exists() or config.read_text(encoding="utf-8") != contents:
        temporary = config.with_suffix(".tmp")
        temporary.write_text(contents, encoding="utf-8")
        temporary.replace(config)
    print(f"Model {name} ready for offline separation", flush=True)
    return repo


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", choices=MODELS)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    prepare(args.name, args.cache)
