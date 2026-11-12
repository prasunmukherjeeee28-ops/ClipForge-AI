from __future__ import annotations

import asyncio
import json

from .client import ProcessorClient
from .config import Settings


async def run_once() -> int:
    """Claim one mock job, verify its lease, then release it without media work."""
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

        heartbeat = await client.heartbeat(job_id, lease_id, lease_token)
        print("Heartbeat:", json.dumps(heartbeat, ensure_ascii=False))

        if not heartbeat.get("cancelRequested", False):
            await client.report_progress(
                job_id,
                lease_id,
                lease_token,
                stage="processor_connection_test",
                progress=1,
            )

        released = await client.release(job_id, lease_id, lease_token)
        print(
            "Mock job safely released:",
            json.dumps(
                {"jobId": job_id, "sourcePlatform": job.get("sourcePlatform"), "result": released},
                ensure_ascii=False,
            ),
        )
        return 0
    finally:
        await client.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run_once()))
