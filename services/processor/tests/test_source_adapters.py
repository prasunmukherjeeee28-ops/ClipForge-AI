from __future__ import annotations

import httpx
import pytest

from clipforge_processor.source_adapters import (
    SourceInspectionError,
    TwitchHelixAdapter,
    YouTubeDataApiAdapter,
    inspect_video_url,
    parse_source_reference,
    parse_twitch_duration,
    parse_youtube_duration,
)


@pytest.mark.parametrize(
    ("url", "platform", "source_id"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "youtube", "dQw4w9WgXcQ"),
        ("https://youtube.com/shorts/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/live/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://www.twitch.tv/videos/123456789", "twitch", "123456789"),
    ],
)
def test_parse_supported_video_urls(url: str, platform: str, source_id: str) -> None:
    result = parse_source_reference(url)
    assert result.platform == platform
    assert result.source_id == source_id


@pytest.mark.parametrize(
    "url",
    [
        "http://youtu.be/dQw4w9WgXcQ",
        "https://youtu.be.danger.example/dQw4w9WgXcQ",
        "https://user:pass@youtu.be/dQw4w9WgXcQ",
        "https://youtu.be:8443/dQw4w9WgXcQ",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/channel/UC123",
        "https://www.twitch.tv/somechannel",
        "https://www.twitch.tv/videos/not-a-number",
        "https://127.0.0.1/private",
        "file:///etc/passwd",
    ],
)
def test_reject_unsupported_or_unsafe_source_urls(url: str) -> None:
    with pytest.raises(SourceInspectionError):
        parse_source_reference(url)


def test_youtube_iso_duration_parser() -> None:
    assert parse_youtube_duration("PT1H2M3S") == 3723
    assert parse_youtube_duration("P1DT2H") == 93600
    assert parse_youtube_duration("PT45S") == 45
    assert parse_youtube_duration("not-a-duration") is None


def test_twitch_duration_parser() -> None:
    assert parse_twitch_duration("1h2m3s") == 3723
    assert parse_twitch_duration("42m") == 2520
    assert parse_twitch_duration("9s") == 9
    assert parse_twitch_duration("invalid") is None


@pytest.mark.asyncio
async def test_youtube_adapter_reads_metadata_without_fetching_video_url() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "items": [{
                    "id": "dQw4w9WgXcQ",
                    "snippet": {
                        "title": "Example VOD",
                        "publishedAt": "2026-01-01T00:00:00Z",
                        "liveBroadcastContent": "none",
                    },
                    "contentDetails": {"duration": "PT1H2M3S"},
                    "liveStreamingDetails": {},
                }]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        adapter = YouTubeDataApiAdapter("test-key", client)
        reference = parse_source_reference("https://youtu.be/dQw4w9WgXcQ")
        metadata = await adapter.inspect(reference)

    assert metadata.title == "Example VOD"
    assert metadata.source_type == "video"
    assert metadata.duration_seconds == 3723
    assert metadata.media_access == "authorized_asset_required"
    assert len(requests) == 1
    assert requests[0].url.host == "www.googleapis.com"
    assert requests[0].url.path == "/youtube/v3/videos"
    assert "youtu.be" not in str(requests[0].url)


@pytest.mark.asyncio
async def test_youtube_adapter_detects_live_and_upcoming_sources() -> None:
    fixtures = [
        ({"liveBroadcastContent": "live"}, "live", "live"),
        ({"liveBroadcastContent": "upcoming"}, "live", "upcoming"),
        (
            {"liveBroadcastContent": "none"},
            "video",
            "ended",
        ),
    ]
    for snippet, source_type, live_status in fixtures:
        def handler(_: httpx.Request, snippet: dict = snippet) -> httpx.Response:
            return httpx.Response(
                200,
                json={"items": [{"snippet": snippet, "contentDetails": {"duration": "PT2M"}, "liveStreamingDetails": {"actualStartTime": "2026-01-01T00:00:00Z"} if snippet["liveBroadcastContent"] == "none" else {}}]},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            adapter = YouTubeDataApiAdapter("test-key", client)
            metadata = await adapter.inspect(parse_source_reference("https://youtu.be/dQw4w9WgXcQ"))
        assert metadata.source_type == source_type
        assert metadata.live_status == live_status


@pytest.mark.asyncio
async def test_twitch_adapter_uses_app_token_and_helix_vod_metadata() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "id.twitch.tv":
            return httpx.Response(200, json={"access_token": "short-lived-test-token", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"data": [{
                "id": "123456789",
                "type": "archive",
                "title": "Twitch VOD",
                "created_at": "2026-01-01T00:00:00Z",
                "duration": "2h3m4s",
                "viewable": "public",
            }]},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        adapter = TwitchHelixAdapter("test-client-id", "test-client-secret", client)
        metadata = await adapter.inspect(parse_source_reference("https://www.twitch.tv/videos/123456789"))

    assert metadata.platform == "twitch"
    assert metadata.source_type == "video"
    assert metadata.duration_seconds == 7384
    assert metadata.title == "Twitch VOD"
    assert metadata.media_access == "authorized_asset_required"
    assert [request.url.host for request in seen] == ["id.twitch.tv", "api.twitch.tv"]
    assert seen[1].headers["Authorization"] == "Bearer short-lived-test-token"


@pytest.mark.asyncio
async def test_inspection_requires_platform_credentials() -> None:
    with pytest.raises(SourceInspectionError) as error:
        await inspect_video_url("https://youtu.be/dQw4w9WgXcQ")
    assert error.value.code == "source_credentials_missing"
