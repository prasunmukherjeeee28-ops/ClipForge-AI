from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from clipforge_processor.client import ProcessorClient


@pytest.mark.asyncio
async def test_source_asset_download_streams_to_private_file(tmp_path: Path) -> None:
    payload = b"authorized-video-bytes" * 4096

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/internal/processor/source-asset"
        assert request.headers["X-Processor-Signature"]
        return httpx.Response(
            200,
            headers={"Content-Length": str(len(payload))},
            content=payload,
        )

    client = ProcessorClient("https://clipforge.example", "s" * 40)
    await client.close()
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    destination = tmp_path / "private" / "source.upload"
    try:
        size = await client.download_source_asset(
            "job-1", "lease-1", "token-1", destination, max_bytes=len(payload)
        )
        assert size == len(payload)
        assert destination.read_bytes() == payload
        assert destination.stat().st_mode & 0o777 == 0o600
        assert not destination.with_name("source.upload.partial").exists()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_source_asset_download_rejects_oversized_response_and_cleans_partial(tmp_path: Path) -> None:
    payload = b"x" * 1024

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Length": str(len(payload))}, content=payload)

    client = ProcessorClient("https://clipforge.example", "s" * 40)
    await client.close()
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    destination = tmp_path / "source.upload"
    try:
        with pytest.raises(ValueError, match="configured limit"):
            await client.download_source_asset(
                "job-1", "lease-1", "token-1", destination, max_bytes=100
            )
        assert not destination.exists()
        assert not destination.with_name("source.upload.partial").exists()
    finally:
        await client.close()
