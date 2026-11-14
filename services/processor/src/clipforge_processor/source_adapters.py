from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

import httpx

Platform = Literal["youtube", "twitch", "kick"]
SourceType = Literal["video", "live"]
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
TWITCH_ID_RE = re.compile(r"^[0-9]{1,20}$")
KICK_VOD_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


@dataclass(frozen=True)
class SourceReference:
    platform: Platform
    source_id: str
    canonical_url: str


@dataclass(frozen=True)
class SourceMetadata:
    platform: Platform
    source_id: str
    source_type: SourceType
    title: str
    duration_seconds: int | None
    published_at: str | None
    live_status: str
    # Public metadata APIs do not grant a downloadable media asset. The
    # pipeline must obtain an owner-authorized source file separately.
    media_access: Literal["authorized_asset_required"] = "authorized_asset_required"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class SourceInspectionError(Exception):
    """An expected, user-safe source inspection failure."""

    def __init__(self, code: str, safe_message: str) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message


def parse_source_reference(raw_url: str) -> SourceReference:
    """Parse only supported single-video URLs; never fetch the submitted URL."""
    if not isinstance(raw_url, str) or not raw_url or len(raw_url) > 2048:
        raise SourceInspectionError("invalid_source_url", "The source URL is invalid.")

    try:
        parsed = urlsplit(raw_url.strip())
        port = parsed.port
    except ValueError as exc:
        raise SourceInspectionError("invalid_source_url", "The source URL is invalid.") from exc

    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme.lower() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.fragment
    ):
        raise SourceInspectionError("invalid_source_url", "Only standard HTTPS video URLs are supported.")

    source_id: str | None = None
    platform: Platform | None = None

    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
        platform = "youtube"
        path_parts = [part for part in parsed.path.split("/") if part]
        if host == "youtu.be":
            source_id = path_parts[0] if path_parts else None
        elif parsed.path.rstrip("/") == "/watch":
            source_id = parse_qs(parsed.query).get("v", [None])[0]
        elif len(path_parts) >= 2 and path_parts[0] in {"shorts", "live", "embed"}:
            source_id = path_parts[1]
        if not source_id or not YOUTUBE_ID_RE.fullmatch(source_id):
            raise SourceInspectionError("unsupported_source_url", "Use a YouTube URL for one specific video or VOD.")

        return SourceReference("youtube", source_id, f"https://www.youtube.com/watch?v={source_id}")

    if host in {"twitch.tv", "www.twitch.tv", "m.twitch.tv"}:
        platform = "twitch"
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) >= 2 and path_parts[0].lower() == "videos":
            source_id = path_parts[1]
        if not source_id or not TWITCH_ID_RE.fullmatch(source_id):
            raise SourceInspectionError("unsupported_source_url", "Use a Twitch URL for one specific VOD, such as /videos/123456.")

        return SourceReference("twitch", source_id, f"https://www.twitch.tv/videos/{source_id}")

    if host in {"kick.com", "www.kick.com"}:
        path_parts = [part for part in parsed.path.split("/") if part]
        if (
            len(path_parts) == 3
            and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", path_parts[0])
            and path_parts[1].lower() == "videos"
            and KICK_VOD_ID_RE.fullmatch(path_parts[2])
        ):
            source_id = path_parts[2].lower()
            canonical = f"https://kick.com/{path_parts[0]}/videos/{source_id}"
            return SourceReference("kick", source_id, canonical)
        raise SourceInspectionError(
            "unsupported_source_url",
            "Use one Kick VOD URL in the form https://kick.com/channel/videos/video-id.",
        )

    raise SourceInspectionError("unsupported_source_url", "Only supported YouTube videos, Twitch VODs, and Kick VODs are accepted.")


def parse_youtube_duration(value: str | None) -> int | None:
    if not value:
        return None
    match = re.fullmatch(
        r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?",
        value,
    )
    if not match:
        return None
    days, hours, minutes, seconds = match.groups()
    total = (
        int(days or 0) * 86400
        + int(hours or 0) * 3600
        + int(minutes or 0) * 60
        + int(float(seconds or 0))
    )
    return total


def parse_twitch_duration(value: str | None) -> int | None:
    if not value:
        return None
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", value)
    if not match or not any(match.groups()):
        return None
    hours, minutes, seconds = match.groups()
    return int(hours or 0) * 3600 + int(minutes or 0) * 60 + int(seconds or 0)


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as exc:
        raise SourceInspectionError("provider_response_invalid", "The video platform returned an invalid response.") from exc
    if not isinstance(value, dict):
        raise SourceInspectionError("provider_response_invalid", "The video platform returned an invalid response.")
    return value


class YouTubeDataApiAdapter:
    """Official YouTube Data API metadata adapter; it does not download video bytes."""

    endpoint = "https://www.googleapis.com/youtube/v3/videos"

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None) -> None:
        if not api_key:
            raise ValueError("A YouTube Data API key is required.")
        self._api_key = api_key
        self._client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=False)
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def inspect(self, reference: SourceReference) -> SourceMetadata:
        if reference.platform != "youtube":
            raise ValueError("YouTube adapter received a non-YouTube source.")
        try:
            response = await self._client.get(
                self.endpoint,
                params={
                    "part": "snippet,contentDetails,liveStreamingDetails",
                    "id": reference.source_id,
                    "key": self._api_key,
                },
            )
        except httpx.HTTPError as exc:
            raise SourceInspectionError("provider_unreachable", "YouTube metadata could not be reached.") from exc

        if response.status_code == 404:
            raise SourceInspectionError("source_not_found", "The YouTube video was not found.")
        if response.status_code != 200:
            # Do not expose the response body or API key-bearing request URL.
            raise SourceInspectionError("provider_api_error", "YouTube could not provide metadata for this video.")

        payload = _json_object(response)
        items = payload.get("items")
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            raise SourceInspectionError("source_not_found", "The YouTube video was not found or is not publicly inspectable.")

        item = items[0]
        snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
        details = item.get("contentDetails") if isinstance(item.get("contentDetails"), dict) else {}
        live_details = item.get("liveStreamingDetails") if isinstance(item.get("liveStreamingDetails"), dict) else {}
        broadcast = snippet.get("liveBroadcastContent", "none")
        actual_end = live_details.get("actualEndTime")
        actual_start = live_details.get("actualStartTime")

        if broadcast == "live":
            source_type: SourceType = "live"
            live_status = "live"
        elif broadcast == "upcoming":
            source_type = "live"
            live_status = "upcoming"
        elif actual_start and not actual_end:
            source_type = "live"
            live_status = "live"
        else:
            source_type = "video"
            live_status = "ended" if actual_end else "not_live"

        title = snippet.get("title")
        return SourceMetadata(
            platform="youtube",
            source_id=reference.source_id,
            source_type=source_type,
            title=title.strip()[:200] if isinstance(title, str) and title.strip() else "Untitled YouTube video",
            duration_seconds=parse_youtube_duration(details.get("duration") if isinstance(details.get("duration"), str) else None),
            published_at=snippet.get("publishedAt") if isinstance(snippet.get("publishedAt"), str) else None,
            live_status=live_status,
        )


class TwitchHelixAdapter:
    """Official Twitch Helix VOD metadata adapter using app credentials."""

    token_endpoint = "https://id.twitch.tv/oauth2/token"
    videos_endpoint = "https://api.twitch.tv/helix/videos"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not client_id or not client_secret:
            raise ValueError("Twitch client credentials are required.")
        self._client_id = client_id
        self._client_secret = client_secret
        self._client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=False)
        self._owns_client = client is None
        self._access_token: str | None = None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get_app_token(self) -> str:
        if self._access_token:
            return self._access_token
        try:
            response = await self._client.post(
                self.token_endpoint,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "grant_type": "client_credentials",
                },
            )
        except httpx.HTTPError as exc:
            raise SourceInspectionError("provider_unreachable", "Twitch authentication could not be reached.") from exc

        if response.status_code != 200:
            raise SourceInspectionError("provider_auth_error", "Twitch metadata authentication failed.")
        payload = _json_object(response)
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise SourceInspectionError("provider_auth_error", "Twitch did not issue a valid metadata token.")
        self._access_token = token
        return token

    async def inspect(self, reference: SourceReference) -> SourceMetadata:
        if reference.platform != "twitch":
            raise ValueError("Twitch adapter received a non-Twitch source.")
        token = await self._get_app_token()
        try:
            response = await self._client.get(
                self.videos_endpoint,
                params={"id": reference.source_id},
                headers={
                    "Client-ID": self._client_id,
                    "Authorization": f"Bearer {token}",
                },
            )
        except httpx.HTTPError as exc:
            raise SourceInspectionError("provider_unreachable", "Twitch VOD metadata could not be reached.") from exc

        if response.status_code == 404:
            raise SourceInspectionError("source_not_found", "The Twitch VOD was not found.")
        if response.status_code != 200:
            raise SourceInspectionError("provider_api_error", "Twitch could not provide metadata for this VOD.")

        payload = _json_object(response)
        items = payload.get("data")
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            raise SourceInspectionError("source_not_found", "The Twitch VOD was not found or is not available to this app.")

        item = items[0]
        viewable = item.get("viewable")
        if viewable not in (None, "public"):
            raise SourceInspectionError("source_not_viewable", "This Twitch VOD is not publicly viewable.")
        video_type = item.get("type")
        if video_type not in {"archive", "highlight", "upload"}:
            raise SourceInspectionError("unsupported_source_type", "This Twitch video type is not supported.")

        title = item.get("title")
        return SourceMetadata(
            platform="twitch",
            source_id=reference.source_id,
            source_type="video",
            title=title.strip()[:200] if isinstance(title, str) and title.strip() else "Untitled Twitch VOD",
            duration_seconds=parse_twitch_duration(item.get("duration") if isinstance(item.get("duration"), str) else None),
            published_at=item.get("created_at") if isinstance(item.get("created_at"), str) else None,
            live_status="ended",
        )


async def inspect_video_url(
    raw_url: str,
    *,
    youtube_api_key: str | None = None,
    twitch_client_id: str | None = None,
    twitch_client_secret: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> SourceMetadata:
    """Inspect a submitted URL through official metadata APIs only."""
    reference = parse_source_reference(raw_url)
    if reference.platform == "kick":
        raise SourceInspectionError(
            "source_metadata_unsupported",
            "Kick VOD metadata is read from the supported video import; use the link importer.",
        )
    if reference.platform == "youtube":
        if not youtube_api_key:
            raise SourceInspectionError("source_credentials_missing", "YouTube metadata inspection is not configured.")
        adapter = YouTubeDataApiAdapter(youtube_api_key, client)
    else:
        if not twitch_client_id or not twitch_client_secret:
            raise SourceInspectionError("source_credentials_missing", "Twitch metadata inspection is not configured.")
        adapter = TwitchHelixAdapter(twitch_client_id, twitch_client_secret, client)
    try:
        return await adapter.inspect(reference)
    finally:
        await adapter.close()
