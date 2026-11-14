from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from clipforge_processor import source_download
from clipforge_processor.source_download import SourceDownloadError, download_public_vod


KICK_URL = "https://kick.com/streamer/videos/01a0251f-ef48-702d-9289-d66922da0e84"


class FakeYoutubeDL:
    def __init__(self, options: dict[str, Any], info: dict[str, Any]) -> None:
        self.options = options
        self.info = info

    def __enter__(self) -> "FakeYoutubeDL":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def extract_info(self, _url: str, *, download: bool) -> dict[str, Any]:
        assert download is True
        output = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
        output.write_bytes(b"test-video-bytes")
        return {**self.info, "filepath": str(output)}


def test_download_public_kick_vod_writes_private_source_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    info = {
        "id": "01a0251f-ef48-702d-9289-d66922da0e84",
        "title": "A Kick VOD",
        "duration": 120,
        "upload_date": "20261114",
        "age_limit": 0,
        "availability": "public",
    }
    monkeypatch.setattr(
        source_download,
        "YoutubeDL",
        lambda options: FakeYoutubeDL(options, info),
    )

    destination = tmp_path / "job" / "source.upload"
    result = download_public_vod(KICK_URL, destination)

    assert result.platform == "kick"
    assert result.source_id == "01a0251f-ef48-702d-9289-d66922da0e84"
    assert result.title == "A Kick VOD"
    assert result.duration_seconds == 120
    assert result.size_bytes == len(b"test-video-bytes")
    assert destination.read_bytes() == b"test-video-bytes"
    assert destination.stat().st_mode & 0o777 == 0o600


def test_download_rejects_age_restricted_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    info = {
        "id": "01a0251f-ef48-702d-9289-d66922da0e84",
        "title": "Restricted VOD",
        "duration": 120,
        "age_limit": 18,
        "availability": "public",
    }
    monkeypatch.setattr(
        source_download,
        "YoutubeDL",
        lambda options: FakeYoutubeDL(options, info),
    )

    destination = tmp_path / "job" / "source.upload"
    with pytest.raises(SourceDownloadError) as error:
        download_public_vod(KICK_URL, destination)

    assert error.value.code == "source_age_restricted"
    assert not destination.exists()
    assert not list(destination.parent.glob("source_dl.*"))


def test_download_rejects_subscriber_only_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    info = {
        "id": "01a0251f-ef48-702d-9289-d66922da0e84",
        "title": "Subscriber VOD",
        "duration": 120,
        "age_limit": 0,
        "availability": "subscriber_only",
    }
    monkeypatch.setattr(
        source_download,
        "YoutubeDL",
        lambda options: FakeYoutubeDL(options, info),
    )

    destination = tmp_path / "job" / "source.upload"
    with pytest.raises(SourceDownloadError) as error:
        download_public_vod(KICK_URL, destination)

    assert error.value.code == "source_access_restricted"
    assert not destination.exists()
    assert not list(destination.parent.glob("source_dl.*"))
