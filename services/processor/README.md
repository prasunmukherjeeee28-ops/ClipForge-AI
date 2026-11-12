# ClipForge Python Processor

D1-backed single-job processor with official YouTube/Twitch VOD metadata inspection. This is the first source-ingestion layer, not yet a clip generator.

## What it does now
- Signs machine requests with HMAC-SHA256 and one-time nonces.
- Claims one queued D1 job with a short-lived lease.
- Parses one specific YouTube video or Twitch VOD URL without fetching the submitted page.
- Inspects metadata through the official YouTube Data API or Twitch Helix API.
- Detects normal VODs, completed livestream archives, active livestreams and upcoming livestreams.
- Persists verified source ID, title, duration and publication timestamp through a lease-protected Worker callback.
- Stops safely when the source is live or when no creator-authorized media asset is available.

It does not scrape platform pages, extract undocumented playback URLs, bypass access controls, or download media bytes. Official platform metadata is not a grant to download the video. FFmpeg, transcription, AI moment detection and R2 upload are later pipeline stages.

## Requirements
- Python 3.11+
- A deployed Worker with migrations `0001_initial.sql` through `0003_processor_request_nonces.sql` applied.
- Cloudflare Access configured for the two intended users.
- Worker secret `PROCESSOR_SHARED_SECRET` set to a random value of at least 32 characters.
- The same secret supplied to this process through its environment. Never put it in Git.
- `YOUTUBE_DATA_API_KEY` for YouTube metadata inspection.
- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` for Twitch Helix app-token metadata inspection. These remain server-side environment secrets.

## Local setup
From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Set `CLIPFORGE_API_BASE_URL` and `PROCESSOR_SHARED_SECRET` in your shell environment (or load them from a local, untracked .env file). The code does not automatically read .env files.

Run the authenticated health check:

```bash
python -m clipforge_processor.health_check
```

Inspect a single URL without claiming a job:

```bash
YOUTUBE_DATA_API_KEY=... python -m clipforge_processor.source_probe 'https://youtu.be/VIDEO_ID'
```

For Twitch, set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` instead.

Run one processor cycle:

```bash
python -m clipforge_processor.worker
```

The worker claims one job, fetches metadata from the relevant official API, saves it to D1 and then records an explicit stop reason. A VOD currently ends with `authorized_media_asset_required`; a live/upcoming source ends with `live_source_not_supported`. This is deliberate until an owner-authorized media-file ingestion path is implemented. Do not run multiple copies of this one-job worker simultaneously.

Run unit tests:

```bash
pytest
```

## Request signing
The client signs the exact bytes sent in the HTTP body. The canonical message is:

```text
unix_timestamp + newline
lowercase_32_character_nonce + newline
HTTP_METHOD + newline
URL_PATHNAME + newline
exact_raw_body
```

Each request uses a fresh random nonce. The Worker stores only its SHA-256 hash and rejects replayed nonces.

The Worker checks the timestamp (±300 seconds) and verifies the HMAC. Each claim also returns a per-job lease token. Only its SHA-256 hash is stored in D1. Never log or persist the raw lease token.

## Next implementation steps
1. Turn the smoke-test into a supervised single-job worker loop with periodic heartbeats and graceful shutdown.
2. Add a real pipeline behind an authorized-source adapter; repeat URL, redirect, DNS and IP validation before network access.
3. Add bounded scratch storage, ffprobe, audio extraction and CPU-gated transcription.
4. Add candidate generation, provider-independent AI scoring and deterministic clip IDs.
5. Add FFmpeg rendering, private R2 upload and idempotent clip registration.
6. Add integration tests for lease races, expired lease recovery, cancellation, and per-user isolation.

Do not deploy paid infrastructure or add platform download behavior without confirming source permissions and applicable platform rules.
