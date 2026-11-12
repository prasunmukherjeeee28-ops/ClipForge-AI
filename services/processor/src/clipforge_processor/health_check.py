from __future__ import annotations

import asyncio
import json

import httpx

from .client import ProcessorClient
from .config import Settings


async def main() -> int:
    settings = Settings.from_env()
    client = ProcessorClient(
        settings.api_base_url,
        settings.shared_secret,
        settings.http_timeout_seconds,
    )
    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as http:
            response = await http.get(f"{settings.api_base_url}/health")
            response.raise_for_status()
            print("Public API health:", json.dumps(response.json(), ensure_ascii=False))

        result = await client.ping()
        print("Authenticated processor ping:", json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        await client.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
