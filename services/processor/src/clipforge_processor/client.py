from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Any

import httpx


def signed_headers(
    secret: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Sign the exact bytes sent to the Worker API with a one-time nonce."""
    stamp = str(timestamp if timestamp is not None else int(time.time()))
    request_nonce = nonce or secrets.token_hex(16)
    if len(request_nonce) != 32 or any(char not in "0123456789abcdefABCDEF" for char in request_nonce):
        raise ValueError("nonce must be 32 hexadecimal characters")
    request_nonce = request_nonce.lower()
    canonical = b"\n".join(
        [
            stamp.encode("ascii"),
            request_nonce.encode("ascii"),
            method.upper().encode("ascii"),
            path.encode("utf-8"),
            body,
        ]
    )
    signature = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "X-Processor-Timestamp": stamp,
        "X-Processor-Nonce": request_nonce,
        "X-Processor-Signature": signature,
    }


class ProcessorClient:
    def __init__(
        self,
        base_url: str,
        secret: str,
        timeout_seconds: float = 20,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._http = httpx.AsyncClient(timeout=timeout_seconds)

    async def close(self) -> None:
        await self._http.aclose()

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = signed_headers(self._secret, "POST", path, body)
        response = await self._http.post(
            f"{self._base_url}{path}",
            content=body,
            headers=headers,
        )
        response.raise_for_status()
        return response.json()

    async def ping(self) -> dict[str, Any]:
        return await self.post("/internal/processor/ping", {})

    async def claim(self, worker_id: str) -> dict[str, Any]:
        return await self.post("/internal/processor/claim", {"workerId": worker_id})

    async def heartbeat(self, job_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/heartbeat",
            {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token},
        )

    async def report_progress(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        stage: str,
        progress: int,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/progress",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "stage": stage,
                "progress": progress,
            },
        )

    async def complete(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": job_id,
            "leaseId": lease_id,
            "leaseToken": lease_token,
        }
        if title is not None:
            payload["title"] = title
        return await self.post("/internal/processor/complete", payload)

    async def fail(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        error_code: str,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/fail",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "errorCode": error_code,
            },
        )

    async def report_source_metadata(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        *,
        source_id: str,
        source_platform: str,
        source_type: str,
        title: str,
        duration_seconds: int | None,
        published_at: str | None,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/source-metadata",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "sourceId": source_id,
                "sourcePlatform": source_platform,
                "sourceType": source_type,
                "title": title,
                "durationSeconds": duration_seconds,
                "publishedAt": published_at,
            },
        )

    async def download_source_asset(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        destination: "Path",
        *,
        max_bytes: int = 2_147_483_648,
    ) -> int:
        """Stream the lease-owned R2 source object to a private local file."""
        from pathlib import Path

        if not isinstance(destination, Path):
            destination = Path(destination)
        payload = {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token}
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        path = "/internal/processor/source-asset"
        headers = signed_headers(self._secret, "POST", path, body)
        partial = destination.with_name(destination.name + ".partial")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial.unlink(missing_ok=True)
        total = 0
        try:
            async with self._http.stream(
                "POST", f"{self._base_url}{path}", content=body, headers=headers
            ) as response:
                response.raise_for_status()
                raw_length = response.headers.get("content-length")
                if raw_length is None or not raw_length.isdigit():
                    raise ValueError("Source response did not include a valid content length.")
                expected = int(raw_length)
                if expected < 1 or expected > max_bytes:
                    raise ValueError("Source asset size is outside the configured limit.")
                with partial.open("xb") as output:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes or total > expected:
                            raise ValueError("Source response exceeded its verified size.")
                        output.write(chunk)
                if total != expected:
                    raise ValueError("Source response ended before the verified size was downloaded.")
            partial.chmod(0o600)
            partial.replace(destination)
            return total
        except BaseException:
            partial.unlink(missing_ok=True)
            raise

    async def report_media_ready(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        *,
        container: str,
        video_codec: str,
        source_audio_codec: str,
        width: int,
        height: int,
        duration_seconds: float,
        audio_size_bytes: int,
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/media-ready",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "container": container,
                "videoCodec": video_codec,
                "sourceAudioCodec": source_audio_codec,
                "width": width,
                "height": height,
                "durationSeconds": duration_seconds,
                "audioCodec": "pcm_s16le",
                "audioSampleRate": 16000,
                "audioChannels": 1,
                "audioSizeBytes": audio_size_bytes,
            },
        )

    async def report_transcription_ready(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        *,
        container: str,
        video_codec: str,
        source_audio_codec: str,
        width: int,
        height: int,
        duration_seconds: float,
        audio_size_bytes: int,
        transcript_model: str,
        transcript_language: str | None,
        transcript_segment_count: int,
        transcript_size_bytes: int,
        transcript_sha256: str,
    ) -> dict[str, Any]:
        """Persist media and transcript metadata and complete this leased processing stage."""
        return await self.post(
            "/internal/processor/transcription-ready",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "container": container,
                "videoCodec": video_codec,
                "sourceAudioCodec": source_audio_codec,
                "width": width,
                "height": height,
                "durationSeconds": duration_seconds,
                "audioCodec": "pcm_s16le",
                "audioSampleRate": 16000,
                "audioChannels": 1,
                "audioSizeBytes": audio_size_bytes,
                "transcriptModel": transcript_model,
                "transcriptLanguage": transcript_language,
                "transcriptSegmentCount": transcript_segment_count,
                "transcriptSizeBytes": transcript_size_bytes,
                "transcriptSha256": transcript_sha256,
            },
        )

    async def report_moments_ready(
        self,
        job_id: str,
        lease_id: str,
        lease_token: str,
        *,
        candidates: list[dict[str, Any]],
        generation_id: str | None = None,
    ) -> dict[str, Any]:
        """Persist a bounded owner-scoped candidate batch and finish the analysis lease."""
        return await self.post(
            "/internal/processor/moments-ready",
            {
                "jobId": job_id,
                "leaseId": lease_id,
                "leaseToken": lease_token,
                "generationId": generation_id or secrets.token_hex(16),
                "candidates": candidates,
            },
        )

    async def claim_render(self, worker_id: str) -> dict[str, Any]:
        return await self.post("/internal/processor/render-claim", {"workerId": worker_id})

    async def render_heartbeat(self, clip_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/render-heartbeat",
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token},
        )

    async def render_progress(
        self, clip_id: str, lease_id: str, lease_token: str, progress: int
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/render-progress",
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token, "progress": progress},
        )

    async def download_render_source(
        self,
        clip_id: str,
        lease_id: str,
        lease_token: str,
        destination: "Path",
        *,
        max_bytes: int = 2_147_483_648,
    ) -> int:
        """Stream an owner-authorized source file under a current clip-render lease."""
        from pathlib import Path

        if not isinstance(destination, Path):
            destination = Path(destination)
        payload = {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token}
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        path = "/internal/processor/render-source"
        headers = signed_headers(self._secret, "POST", path, body)
        partial = destination.with_name(destination.name + ".partial")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial.unlink(missing_ok=True)
        total = 0
        try:
            async with self._http.stream(
                "POST", f"{self._base_url}{path}", content=body, headers=headers
            ) as response:
                response.raise_for_status()
                raw_length = response.headers.get("content-length")
                if raw_length is None or not raw_length.isdigit():
                    raise ValueError("Render source did not include a valid content length.")
                expected = int(raw_length)
                if expected < 1 or expected > max_bytes:
                    raise ValueError("Render source size is outside the configured limit.")
                with partial.open("xb") as output:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes or total > expected:
                            raise ValueError("Render source response exceeded its verified size.")
                        output.write(chunk)
                if total != expected:
                    raise ValueError("Render source response ended before the verified size was downloaded.")
            partial.chmod(0o600)
            partial.replace(destination)
            return total
        except BaseException:
            partial.unlink(missing_ok=True)
            raise

    async def render_upload_init(
        self, clip_id: str, lease_id: str, lease_token: str, size_bytes: int
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/render-upload-init",
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token, "sizeBytes": size_bytes},
        )

    async def upload_render_part(
        self,
        clip_id: str,
        lease_id: str,
        lease_token: str,
        part_number: int,
        payload: bytes,
    ) -> dict[str, Any]:
        """Sign an envelope and bounded binary part as one exact request body."""
        path = f"/internal/processor/render-upload-part/{clip_id}/{part_number}"
        metadata = json.dumps(
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token},
            separators=(",", ":"),
        ).encode("utf-8")
        if len(metadata) > 2048:
            raise ValueError("Render upload metadata is too large.")
        packet = len(metadata).to_bytes(4, "big") + metadata + payload
        headers = signed_headers(self._secret, "POST", path, packet)
        headers["content-type"] = "application/octet-stream"
        response = await self._http.post(
            f"{self._base_url}{path}",
            content=packet,
            headers=headers,
        )
        response.raise_for_status()
        return response.json()

    async def render_complete(
        self, clip_id: str, lease_id: str, lease_token: str
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/render-complete",
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token},
        )

    async def render_fail(
        self, clip_id: str, lease_id: str, lease_token: str, error_code: str
    ) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/render-fail",
            {"clipId": clip_id, "leaseId": lease_id, "leaseToken": lease_token, "errorCode": error_code},
        )

    async def mark_source_ready(self, job_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        """Move a VOD with a ready owner-provided file into the source-ready review state."""
        return await self.post(
            "/internal/processor/source-ready",
            {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token},
        )

    async def release(self, job_id: str, lease_id: str, lease_token: str) -> dict[str, Any]:
        return await self.post(
            "/internal/processor/release",
            {"jobId": job_id, "leaseId": lease_id, "leaseToken": lease_token},
        )
