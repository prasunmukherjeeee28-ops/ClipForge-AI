from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    shared_secret: str
    worker_id: str
    http_timeout_seconds: float = 20.0
    youtube_data_api_key: str | None = None
    twitch_client_id: str | None = None
    twitch_client_secret: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        base_url = os.environ.get("CLIPFORGE_API_BASE_URL", "").strip().rstrip("/")
        secret = os.environ.get("PROCESSOR_SHARED_SECRET", "")
        worker_id = os.environ.get("PROCESSOR_WORKER_ID", "clipforge-worker-1").strip()
        timeout_raw = os.environ.get("PROCESSOR_HTTP_TIMEOUT_SECONDS", "20")

        parsed = urlparse(base_url)
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("CLIPFORGE_API_BASE_URL must be an absolute HTTP(S) URL")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("HTTPS is required except for local development")
        if len(secret) < 32:
            raise ValueError("PROCESSOR_SHARED_SECRET must contain at least 32 characters")
        if not worker_id or len(worker_id) > 100:
            raise ValueError("PROCESSOR_WORKER_ID must be 1–100 characters")
        try:
            timeout = float(timeout_raw)
        except ValueError as exc:
            raise ValueError("PROCESSOR_HTTP_TIMEOUT_SECONDS must be numeric") from exc
        if timeout < 1 or timeout > 120:
            raise ValueError("PROCESSOR_HTTP_TIMEOUT_SECONDS must be between 1 and 120")

        return cls(
            api_base_url=base_url,
            shared_secret=secret,
            worker_id=worker_id,
            http_timeout_seconds=timeout,
            youtube_data_api_key=os.environ.get("YOUTUBE_DATA_API_KEY") or None,
            twitch_client_id=os.environ.get("TWITCH_CLIENT_ID") or None,
            twitch_client_secret=os.environ.get("TWITCH_CLIENT_SECRET") or None,
        )
