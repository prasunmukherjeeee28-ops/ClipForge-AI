from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from .source_adapters import SourceInspectionError, inspect_video_url


async def _run(url: str) -> int:
    try:
        metadata = await inspect_video_url(
            url,
            youtube_api_key=os.environ.get("YOUTUBE_DATA_API_KEY"),
            twitch_client_id=os.environ.get("TWITCH_CLIENT_ID"),
            twitch_client_secret=os.environ.get("TWITCH_CLIENT_SECRET"),
        )
    except SourceInspectionError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.safe_message}}), file=sys.stderr)
        return 1

    print(json.dumps(metadata.as_dict(), ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a YouTube video or Twitch VOD using official metadata APIs.")
    parser.add_argument("url", help="HTTPS URL for one YouTube video or Twitch VOD")
    args = parser.parse_args()
    return asyncio.run(_run(args.url))


if __name__ == "__main__":
    raise SystemExit(main())
