# ClipForge Python Processor

D1-backed single-job processor with official YouTube/Twitch VOD metadata inspection and private creator-authorized source-file uploads. This is source ingestion, not yet a clip generator.

## What it does now
- Signs machine requests with HMAC-SHA256 and one-time nonces.
- Claims one queued D1 job with a short-lived lease, only after a completed user-owned source asset is attached.
- Accepts creator-authorized original/export files through authenticated, resumable 8 MiB R2 multipart uploads (2 GiB per file; 8 GiB per account).
- Keeps source objects private and binds each asset to its owner and at most one job.
- Parses one specific YouTube video or Twitch VOD URL without fetching the submitted page.
- Inspects metadata through the official YouTube Data API or Twitch Helix API.
- Detects normal VODs, completed livestream archives, active livestreams and upcoming livestreams.
- Persists verified source ID, title, duration and publication timestamp through a lease-protected Worker callback.
- Stops safely when the source is live; a VOD with an attached ready source file transitions to `source_ready`.

It does not scrape platform pages, extract undocumented playback URLs, bypass access controls, or download media from YouTube/Twitch. The account owner must upload an original/export or another provider-approved file they have permission to process. Official platform metadata does not prove that permission or prove that the uploaded file matches the linked VOD. The API stores the supplied file in private R2; FFprobe validation, processor-side retrieval, transcription, AI moment detection and clip rendering are later pipeline stages.

## Requirements
- Python 3.11+
- A deployed Worker with migrations `0001_initial.sql` through `0005_authorized_source_assets.sql` applied.
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

The worker claims one job only after a ready private source asset is attached. It fetches platform metadata from the official API, saves it to D1 and moves a VOD job to `source_ready`; live/upcoming sources end with `live_source_not_supported`. It does not yet read the R2 object or run FFprobe/FFmpeg. Do not run multiple copies of this one-job worker simultaneously.

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

## Source asset upload flow
1. The user creates a job with one supported YouTube/Twitch URL; it waits in `review` / `awaiting_source_asset`.
2. The app creates an upload with `POST /api/source-assets`, passing `filename`, `contentType` and `sizeBytes`.
3. The app sends each fixed-size chunk to `PUT /api/source-assets/:assetId/parts/:partNumber`. `GET /api/source-assets/:assetId` reports completed parts so an interrupted upload can resume.
4. `POST /api/source-assets/:assetId/complete` finalizes the R2 multipart upload after the server verifies every part number and size.
5. `POST /api/jobs/:jobId/source-asset` attaches that ready asset to the user's job and queues it for metadata inspection.
6. The processor verifies the platform metadata and moves a VOD to `source_ready`.

The API currently allows MP4, MOV, WebM and Matroska MIME/filename combinations. These are client declarations, not proof of file contents; the next media-validation stage must use FFprobe before attempting to process the file. Each asset is limited to 2 GiB and each user to 8 GiB of ready/in-progress source storage. R2 multipart parts use 8 MiB chunks and are stored under a server-generated owner-scoped key.

## Next implementation steps
1. Add a tightly scoped processor-side path to read the user's attached private R2 object, with lease/ownership validation.
2. Add FFprobe validation, bounded scratch storage and audio extraction.
3. Add CPU-gated transcription, candidate generation and provider-independent AI scoring.
4. Add FFmpeg rendering, subtitles, private clip storage and idempotent clip registration.
5. Add integration tests for lease races, cancellation, upload retries and full two-user isolation.
6. Add live capture after the VOD pipeline is stable.

Do not deploy paid infrastructure or add platform download behavior without confirming source permissions and applicable platform rules.
