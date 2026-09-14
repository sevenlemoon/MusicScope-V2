import logging

import pytest

from app.core.redaction import contains_sensitive_fields, install_log_redaction, redact


def test_nested_session_values_are_redacted() -> None:
    payload = {
        "profile": {"id": "42"},
        "Cookie": "provider-session-sentinel",
        "nested": [{"refresh-token": "abc"}, {"safe": ("value",)}],
    }
    assert redact(payload) == {
        "profile": {"id": "42"},
        "Cookie": "[REDACTED]",
        "nested": [{"refresh-token": "[REDACTED]"}, {"safe": ("value",)}],
    }


def test_sensitive_field_detection_is_recursive() -> None:
    assert contains_sensitive_fields({"metadata": [{"provider_session": "private"}]})
    assert not contains_sensitive_fields({"metadata": [{"provider": "netease"}]})


def test_structured_log_records_are_redacted_recursively(caplog: pytest.LogCaptureFixture) -> None:
    install_log_redaction()
    logger = logging.getLogger("tests.security")
    with caplog.at_level(logging.WARNING):
        logger.warning("provider state: %s", {"nested": {"access_token": "never-log-me"}})

    output = caplog.text
    assert "never-log-me" not in output
    assert "[REDACTED]" in output
