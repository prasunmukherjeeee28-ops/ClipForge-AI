# ClipForge AI

**Find the moment. Forge the clip.**

A private clipping workspace for exactly two trusted accounts: the owner and one invited friend. Each account has its own jobs, source uploads, clip library and history. There are no public customer accounts, no shared library, and no Instagram login or automatic publishing.

Process only original/export or provider-approved media that the user has permission to use. YouTube/Twitch URLs are used for official metadata inspection; the app does not scrape platform pages or bypass playback restrictions.

## Stack

- React + TypeScript + Vite + Tailwind web app (installable PWA target)
- Cloudflare Worker + Hono API and Cloudflare Access
- Cloudflare D1 for users, job lifecycle, leases, moment candidates and clip metadata
- Private Backblaze B2 (S3-compatible) object storage for source files and generated MP4s
- Separate Python processor with FFmpeg/FFprobe and local faster-whisper transcription
- Deterministic multimodal moment ranking with optional provider-backed transcript refinement

## Processing lifecycle

1. Each user submits a supported source URL or bulk list and uploads an authorized source file.
2. The API stores the source in private object storage and binds it to the submitting user's job in D1.
3. The single Python processor polls the Worker, claims one job through an expiring HMAC-protected lease and validates the uploaded media.
4. The processor extracts audio, transcribes locally, scores moment candidates, renders up to three vertical 9:16 MP4 clips with subtitles and uploads them to private object storage.
5. The Worker verifies clip objects and registers each clip in D1. The user previews or downloads only their own clips and publishes manually to their own social account.

D1 is the sole job-dispatch source. Cloudflare Queues are intentionally not part of the current single-worker design.

## Development

- Web: `apps/web`
- Worker API: `apps/api`
- Database migrations: `database/migrations`
- Python processor: `services/processor`
- Processor container: `services/processor/Dockerfile`
- Single-instance Compose service: `compose.processor.yaml`

See `docs/ARCHITECTURE.md`, `docs/API.md`, `apps/api/README.md` and `services/processor/README.md`.

## Current status

The VOD processing code and owner-scoped API routes are present on `main`. The dedicated `clipforge-app-db` D1 database has been created and migrations `0001`–`0009` have been applied. The legacy database remains untouched. R2 activation was unavailable; the project uses Backblaze B2 in code, but B2 is not yet enabled and no private bucket or application key exists. Cloudflare Access is not yet configured, no `clipforge-api` Worker is deployed, and the Python processor host has not been selected. No end-to-end authorized media job has been verified.

Never commit `.env` files, Worker secrets, API keys, lease tokens, uploaded videos, audio, or transcripts. The local `.env.example` is a template only.
