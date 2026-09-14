import logging
from collections.abc import Mapping
from typing import Any

SENSITIVE_KEY_MARKERS = frozenset(
    {
        "api_key",
        "authorization",
        "cookie",
        "credential",
        "password",
        "private_key",
        "secret",
        "session",
        "token",
    }
)


def _is_sensitive_key(key: object) -> bool:
    normalized = str(key).casefold().replace("-", "_")
    return any(marker in normalized for marker in SENSITIVE_KEY_MARKERS)


def contains_sensitive_fields(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            _is_sensitive_key(key) or contains_sensitive_fields(item) for key, item in value.items()
        )
    if isinstance(value, list | tuple):
        return any(contains_sensitive_fields(item) for item in value)
    return False


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if _is_sensitive_key(key) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    return value


def install_log_redaction() -> None:
    """Redact structured logging messages and arguments before any handler sees them."""
    current_factory = logging.getLogRecordFactory()
    if getattr(current_factory, "_musicscope_redacting", False):
        return

    def redacting_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = current_factory(*args, **kwargs)
        record.msg = redact(record.msg)
        record.args = redact(record.args)
        return record

    redacting_factory._musicscope_redacting = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(redacting_factory)
