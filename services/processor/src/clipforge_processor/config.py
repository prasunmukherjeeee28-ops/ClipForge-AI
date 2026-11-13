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
    scratch_dir: str = "/var/lib/clipforge/scratch"
    ffprobe_binary: str = "ffprobe"
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_timeout_seconds: float = 30.0
    ffmpeg_timeout_seconds: float = 3600.0
    max_video_duration_seconds: int = 43200
    max_audio_bytes: int = 1_500_000_000
    ffmpeg_threads: int = 2

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

        def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
            raw = os.environ.get(name, str(default))
            try:
                value = int(raw)
            except ValueError as exc:
                raise ValueError(f"{name} must be an integer") from exc
            if value < minimum or value > maximum:
                raise ValueError(f"{name} must be between {minimum} and {maximum}")
            return value

        def bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
            raw = os.environ.get(name, str(default))
            try:
                value = float(raw)
            except ValueError as exc:
                raise ValueError(f"{name} must be numeric") from exc
            if value < minimum or value > maximum:
                raise ValueError(f"{name} must be between {minimum} and {maximum}")
            return value

        scratch_dir = os.environ.get("PROCESSOR_SCRATCH_DIR", "/var/lib/clipforge/scratch").strip()
        ffprobe_binary = os.environ.get("FFPROBE_BINARY", "ffprobe").strip()
        ffmpeg_binary = os.environ.get("FFMPEG_BINARY", "ffmpeg").strip()
        if not scratch_dir:
            raise ValueError("PROCESSOR_SCRATCH_DIR must not be empty")
        if not ffprobe_binary or not ffmpeg_binary:
            raise ValueError("FFPROBE_BINARY and FFMPEG_BINARY must not be empty")

        return cls(
            api_base_url=base_url,
            shared_secret=secret,
            worker_id=worker_id,
            http_timeout_seconds=timeout,
            youtube_data_api_key=os.environ.get("YOUTUBE_DATA_API_KEY") or None,
            twitch_client_id=os.environ.get("TWITCH_CLIENT_ID") or None,
            twitch_client_secret=os.environ.get("TWITCH_CLIENT_SECRET") or None,
            scratch_dir=scratch_dir,
            ffprobe_binary=ffprobe_binary,
            ffmpeg_binary=ffmpeg_binary,
            ffprobe_timeout_seconds=bounded_float("PROCESSOR_FFPROBE_TIMEOUT_SECONDS", 30.0, 1.0, 300.0),
            ffmpeg_timeout_seconds=bounded_float("PROCESSOR_FFMPEG_TIMEOUT_SECONDS", 3600.0, 10.0, 14400.0),
            max_video_duration_seconds=bounded_int("PROCESSOR_MAX_VIDEO_DURATION_SECONDS", 43200, 60, 43200),
            max_audio_bytes=bounded_int("PROCESSOR_MAX_AUDIO_BYTES", 1_500_000_000, 1024, 1_500_000_000),
            ffmpeg_threads=bounded_int("PROCESSOR_FFMPEG_THREADS", 2, 1, 4),
        )
