import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from audio_worker import prepare_model


def test_interrupted_download_resumes_and_ready_cache_never_uses_network(tmp_path, monkeypatch):
    payload = b"model-weight-fixture" * 100000
    checksum = hashlib.sha256(payload).hexdigest()[:8]
    filename = f"fixture-{checksum}.th"
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            offset = int(self.headers.get("Range", "bytes=0-").split("=")[1].split("-")[0])
            requests.append(offset)
            self.send_response(206 if offset else 200)
            self.send_header("Content-Length", str(len(payload) - offset))
            if offset:
                self.send_header("Content-Range", f"bytes {offset}-{len(payload)-1}/{len(payload)}")
            self.end_headers()
            if len(requests) == 1:
                self.wfile.write(payload[:1024 * 1024])
                self.close_connection = True
            else:
                self.wfile.write(payload[offset:])

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(prepare_model, "MODELS", {"htdemucs_6s": filename})
    monkeypatch.setattr(prepare_model, "BASE_URL", f"http://127.0.0.1:{server.server_port}/")
    monkeypatch.setattr(prepare_model.time, "sleep", lambda _: None)
    try:
        repo = prepare_model.prepare("htdemucs_6s", tmp_path)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert requests == [0, 1024 * 1024]
    assert (repo / filename).read_bytes() == payload
    assert not list(repo.glob("*.part"))

    def no_network(*_args, **_kwargs):
        raise AssertionError("Ready models must not open a network connection")

    monkeypatch.setattr(prepare_model.urllib.request, "urlopen", no_network)
    assert prepare_model.prepare("htdemucs_6s", tmp_path) == repo


def test_invalid_weights_are_not_published(tmp_path, monkeypatch):
    class Response:
        status = 200
        headers = {"Content-Length": "3"}

        def __enter__(self):
            self.sent = False
            return self

        def __exit__(self, *_args):
            pass

        def read(self, _size):
            if self.sent:
                return b""
            self.sent = True
            return b"bad"

    monkeypatch.setattr(prepare_model.urllib.request, "urlopen", lambda *_a, **_k: Response())
    target = tmp_path / "weights.th"
    with pytest.raises(RuntimeError, match="checksum"):
        prepare_model.download("https://example.invalid/weights", target, "00000000")
    assert not target.exists()
    assert not target.with_suffix(".part").exists()


def test_full_disk_preserves_partial_download_for_retry(tmp_path, monkeypatch):
    target = tmp_path / "weights.th"
    partial = target.with_suffix(".part")
    partial.write_bytes(b"part")

    class Response:
        status = 206
        headers = {"Content-Range": "bytes 4-99/100"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    monkeypatch.setattr(prepare_model.urllib.request, "urlopen", lambda *_a, **_k: Response())
    monkeypatch.setattr(prepare_model.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    with pytest.raises(OSError) as error:
        prepare_model.download("https://example.invalid/weights", target, "00000000")
    assert error.value.errno == 28
    assert partial.read_bytes() == b"part"
    assert not target.exists()
