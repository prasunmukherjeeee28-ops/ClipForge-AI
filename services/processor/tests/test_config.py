from __future__ import annotations

import pytest

from clipforge_processor.config import Settings


def configure_minimum_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLIPFORGE_API_BASE_URL", "https://clipforge.example.workers.dev")
    monkeypatch.setenv("PROCESSOR_SHARED_SECRET", "x" * 48)
    monkeypatch.setenv("PROCESSOR_WORKER_ID", "ci-worker")


def test_poll_interval_defaults_to_ten_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    configure_minimum_environment(monkeypatch)
    monkeypatch.delenv("PROCESSOR_POLL_INTERVAL_SECONDS", raising=False)

    settings = Settings.from_env()

    assert settings.poll_interval_seconds == 10.0


@pytest.mark.parametrize("value", ["0", "0.5", "301", "not-a-number"])
def test_poll_interval_is_bounded(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    configure_minimum_environment(monkeypatch)
    monkeypatch.setenv("PROCESSOR_POLL_INTERVAL_SECONDS", value)

    with pytest.raises(ValueError, match="PROCESSOR_POLL_INTERVAL_SECONDS"):
        Settings.from_env()


def test_poll_interval_can_be_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    configure_minimum_environment(monkeypatch)
    monkeypatch.setenv("PROCESSOR_POLL_INTERVAL_SECONDS", "15")

    settings = Settings.from_env()

    assert settings.poll_interval_seconds == 15.0
