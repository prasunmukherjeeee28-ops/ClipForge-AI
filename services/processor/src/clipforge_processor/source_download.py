from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import threading

from yt_dlp import YoutubeDL

from .source_adapters import Platform, SourceInspectionError, parse_source_reference


@dataclass(frozen=True)
class PublicVODDownload:
    source_id: str
    platform: Platform
    title: str
    duration_seconds: int | None
    published_at: str | None
    size_bytes: int


class SourceDownloadError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _published_at(info: dict[str, Any]) -> str | None:
    upload_date = info.get("upload_date")
    if isinstance(upload_date, str) and len(upload_date) == 8 and upload_date.isdigit():
        try:
            return datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            return None
    timestamp = info.get("release_timestamp") or info.get("timestamp")
    if isinstance(timestamp, (int, float)) and timestamp > 0:
        try:
            return datetime.fromtimestamp(timestamp).astimezone().isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    return None


def download_public_vod(
    raw_url: str,
    destination: Path,
    *,
    max_bytes: int = 2_147_483_648,
    max_duration_seconds: int = 43_200,
    cancel_event: threading.Event | None = None,
) -> PublicVODDownload:
    """Download one public, non-live VOD from an explicitly supported platform.

    This intentionally does not use browser cookies, account credentials, proxies,
    geo-unlock options, or playlist expansion. Restricted sources should be supplied
    by the owner as an authorized export instead.
    """
    try:
        reference = parse_source_reference(raw_url)
    except SourceInspectionError as exc:
        raise SourceDownloadError(exc.code, str(exc)) from exc

    if max_bytes < 1 or max_bytes > 2_147_483_648:
        raise ValueError("max_bytes must be between 1 byte and 2 GiB")
    if max_duration_seconds < 60 or max_duration_seconds > 43_200:
        raise ValueError("max_duration_seconds must be between 60 seconds and 12 hours")

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.parent.chmod(0o700)
    temporary_template = destination.parent / "source_dl.%(ext)s"

    def match_filter(info: dict[str, Any], *, incomplete: bool) -> str | None:
        live_status = info.get("live_status")
        if info.get("is_live") or live_status in {"is_live", "is_upcoming"}:
            return "Live and upcoming streams are not supported."
        age_limit = info.get("age_limit")
        if info.get("is_mature") is True or (isinstance(age_limit, (int, float)) and age_limit >= 18):
            return "Age-restricted videos cannot be imported by ClipForge."
        availability = info.get("availability")
        if availability in {"private", "subscriber_only", "premium_only", "needs_auth"}:
            return "This video is private or access-restricted. Use an authorized export instead."
        duration = info.get("duration")
        if isinstance(duration, (int, float)) and duration > max_duration_seconds:
            return "This video is longer than ClipForge's 12-hour source limit."
        size = info.get("filesize") or info.get("filesize_approx")
        if isinstance(size, (int, float)) and size > max_bytes:
            return "This video is larger than ClipForge's 2 GiB source limit."
        return None

    def progress_hook(status: dict[str, Any]) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise SourceDownloadError("cancelled_by_user", "The source download was cancelled.")
        downloaded = status.get("downloaded_bytes")
        if isinstance(downloaded, (int, float)) and downloaded > max_bytes:
            raise SourceDownloadError(
                "source_too_large",
                "This video exceeded ClipForge's 2 GiB source limit while downloading.",
            )

    options: dict[str, Any] = {
        "format": "bestvideo*+bestaudio/best",
        "outtmpl": str(temporary_template),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
        "restrictfilenames": True,
        "max_filesize": max_bytes,
        "socket_timeout": 30,
        "retries": 2,
        "fragment_retries": 2,
        "progress_hooks": [progress_hook],
        "match_filter": match_filter,
        "overwrites": True,
    }

    for path in destination.parent.glob("source_dl.*"):
        path.unlink(missing_ok=True)

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(raw_url, download=True)
            if not isinstance(info, dict):
                raise SourceDownloadError(
                    "source_download_failed",
                    "The video platform did not return usable video information.",
                )
            if info.get("_type") in {"playlist", "multi_video"}:
                raise SourceDownloadError(
                    "unsupported_source_url",
                    "Submit one specific video or VOD, not a playlist.",
                )
            if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
                raise SourceDownloadError(
                    "live_source_not_supported",
                    "Live and upcoming streams are not supported yet.",
                )
            age_limit = info.get("age_limit")
            if info.get("is_mature") is True or (isinstance(age_limit, (int, float)) and age_limit >= 18):
                raise SourceDownloadError(
                    "source_age_restricted",
                    "Age-restricted videos cannot be imported by ClipForge.",
                )
            if info.get("availability") in {"private", "subscriber_only", "premium_only", "needs_auth"}:
                raise SourceDownloadError(
                    "source_access_restricted",
                    "This video is private or access-restricted. Use an authorized export instead.",
                )

            candidate_name = info.get("filepath") or info.get("_filename")
            if not isinstance(candidate_name, str):
                requested = info.get("requested_downloads")
                if isinstance(requested, list) and requested and isinstance(requested[0], dict):
                    candidate_name = requested[0].get("filepath")
            if not isinstance(candidate_name, str):
                candidate_name = ydl.prepare_filename(info)

        candidate = Path(candidate_name).resolve()
        if candidate.parent != destination.parent.resolve() or not candidate.is_file():
            matches = [
                item.resolve()
                for item in destination.parent.glob("source_dl.*")
                if item.is_file() and not item.name.endswith((".part", ".ytdl"))
            ]
            if len(matches) != 1:
                raise SourceDownloadError(
                    "source_download_failed",
                    "The video download did not produce one complete media file.",
                )
            candidate = matches[0]

        size_bytes = candidate.stat().st_size
        if size_bytes < 1:
            raise SourceDownloadError("source_download_failed", "The downloaded video file is empty.")
        if size_bytes > max_bytes:
            raise SourceDownloadError("source_too_large", "The video is larger than ClipForge's 2 GiB source limit.")

        duration = info.get("duration")
        duration_seconds = int(duration) if isinstance(duration, (int, float)) and duration > 0 else None
        if duration_seconds is not None and duration_seconds > max_duration_seconds:
            raise SourceDownloadError("source_too_long", "This video is longer than ClipForge's 12-hour source limit.")

        title = info.get("title")
        safe_title = title.strip()[:200] if isinstance(title, str) and title.strip() else "Imported video"
        os.replace(candidate, destination)
        destination.chmod(0o600)
        return PublicVODDownload(
            source_id=reference.source_id,
            platform=reference.platform,
            title=safe_title,
            duration_seconds=duration_seconds,
            published_at=_published_at(info),
            size_bytes=size_bytes,
        )
    except (SourceDownloadError, SourceInspectionError):
        raise
    except Exception as exc:
        raise SourceDownloadError(
            "source_download_failed",
            "ClipForge could not import this link. It may be private, restricted, unavailable, or blocked by the platform. Use an authorized video export with the upload option.",
        ) from exc
    finally:
        for path in destination.parent.glob("source_dl.*"):
            path.unlink(missing_ok=True)
