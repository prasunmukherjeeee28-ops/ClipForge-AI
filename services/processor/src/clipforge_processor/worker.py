from __future__ import annotations

import asyncio
import json

from .client import ProcessorClient
from .config import Settings
from .source_adapters import SourceInspectionError, inspect_video_url


async def run_once() -> int:
    """Inspect one queued source using official metadata APIs; never scrape media pages."""
    settings = Settings.from_env()
    client = ProcessorClient(
        settings.api_base_url,
        settings.shared_secret,
        settings.http_timeout_seconds,
    )

    try:
        ping = await client.ping()
        print("API authenticated:", json.dumps(ping, ensure_ascii=False))

        claimed = await client.claim(settings.worker_id)
        job = claimed.get("job")
        if job is None:
            print("No queued jobs.")
            return 0

        lease = claimed["lease"]
        job_id = job["id"]
        lease_id = lease["leaseId"]
        lease_token = lease["leaseToken"]

        try:
            metadata = await inspect_video_url(
                job["sourceUrl"],
                youtube_api_key=settings.youtube_data_api_key,
                twitch_client_id=settings.twitch_client_id,
                twitch_client_secret=settings.twitch_client_secret,
            )
            await client.report_source_metadata(
                job_id,
                lease_id,
                lease_token,
                source_id=metadata.source_id,
                source_platform=metadata.platform,
                source_type=metadata.source_type,
                title=metadata.title,
                duration_seconds=metadata.duration_seconds,
                published_at=metadata.published_at,
            )

            if metadata.source_type == "live":
                error_code = "live_source_not_supported"
            else:
                # Public metadata is not a media download grant. A later
                # ingestion step must attach a creator-authorized source file.
                error_code = "authorized_media_asset_required"

            result = await client.fail(job_id, lease_id, lease_token, error_code)
            print(
                "Source inspected; media processing was not started:",
                json.dumps(
                    {
                        "jobId": job_id,
                        "platform": metadata.platform,
                        "sourceType": metadata.source_type,
                        "durationSeconds": metadata.duration_seconds,
                        "mediaAccess": metadata.media_access,
                        "result": result,
                    },
                    ensure_ascii=False,
                ),
            )
            return 0
        except SourceInspectionError as exc:
            result = await client.fail(job_id, lease_id, lease_token, exc.code)
            print(
                "Source inspection stopped:",
                json.dumps({"jobId": job_id, "errorCode": exc.code, "result": result}, ensure_ascii=False),
            )
            return 0
    finally:
        await client.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run_once()))
