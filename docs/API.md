# ClipForge API

Authenticated JSON API behind Cloudflare Access. Every user-facing resource query is scoped to the verified user identity. Processor routes use a separate HMAC-authenticated machine identity.

## User authentication and access
- Cloudflare Access protects the application/API and validates the user's session.
- The Worker independently verifies the `Cf-Access-Jwt-Assertion` signature, issuer and audience.
- An explicit `ALLOWED_EMAILS` allowlist limits access to the two intended accounts.
- Verified Access subjects are provisioned into D1. User IDs are never accepted from request bodies.
- Configure exactly two email addresses before deployment. Do not use public registration.

## Health
- `GET /health` — service status; no secrets.

## Identity
- `GET /api/me` — authenticated user identity.

## User jobs
- `POST /api/jobs` — create 1–20 jobs in one request:
  `{ "urls": ["https://..."], "options": { "captions": true, "vertical": true, "reviewScores": true, "instruction": "..." } }`
- `GET /api/jobs` — list the current user's jobs, including verified source metadata when available.
- `GET /api/jobs/:jobId` — status/progress and verified source metadata for an owned job.
- `POST /api/jobs/:jobId/cancel` — cancel one owned queued job or request cancellation of a processing job.
- `POST /api/jobs/cancel-all` — request cancellation of all active jobs for the current user.
- `GET /api/clips` — list the current user's clip metadata.

Only supported HTTPS YouTube and Twitch URL hostnames are accepted at submission time. The processor then parses one specific video/VOD ID and calls only fixed official metadata API endpoints: YouTube Data API `videos.list`, or Twitch Helix `videos` using a server-side app access token. It does not fetch the submitted platform page or retrieve a media playback URL. Source fields (`sourceId`, `sourceType`, title, duration, publication time and verification time) are saved using the lease-protected source metadata callback. Public metadata does not establish ownership or grant a downloadable media asset. Until creator-authorized media-file ingestion is added, a VOD job stops with `authorized_media_asset_required`; active/upcoming live sources stop with `live_source_not_supported`.

## Processor machine API

D1 is the sole job dispatch/state store. Python polls the Worker API; Cloudflare Queues are not used in this architecture.

Every `POST /internal/processor/*` request must include:
- `X-Processor-Timestamp`: Unix timestamp in seconds, accepted within ±300 seconds.
- `X-Processor-Nonce`: 32 hexadecimal characters generated freshly for every request.
- `X-Processor-Signature`: HMAC-SHA256 hex digest of UTF-8 canonical bytes:
  `timestamp + "\n" + lowercase_nonce + "\n" + uppercase_method + "\n" + pathname + "\n" + exact_raw_body`.
- The Worker stores only the SHA-256 hash of each nonce and rejects reuse. Nonces older than ten minutes are pruned.
- HMAC key is the Worker secret `PROCESSOR_SHARED_SECRET`; never expose it to browser clients or commit it.

Routes:
- `POST /internal/processor/ping` with `{}`: authenticated connectivity check.
- `POST /internal/processor/claim` with `{"workerId":"processor-1"}`: recover expired leases, then atomically claim the oldest queued job. Returns null if idle; otherwise returns the job and a one-time lease token.
- `POST /internal/processor/heartbeat` with `{"jobId":"...","leaseId":"...","leaseToken":"..."}`: extends the 90-second lease and returns whether cancellation was requested.
- `POST /internal/processor/progress` with lease fields plus `stage` and `progress` (integer 0–99): updates stage/progress only for the active lease and while cancellation is not requested.
- `POST /internal/processor/source-metadata` with lease fields plus `sourceId`, `sourceType` (`video` or `live`), `title`, optional `durationSeconds` (0–604800) and optional ISO `publishedAt`: persists verified metadata only for the active unexpired lease. It cannot change another user's job or a cancellation-requested job.
- `POST /internal/processor/release` with lease fields: safely releases a test claim back to queued, or marks it cancelled if cancellation was requested.
- `POST /internal/processor/fail` with lease fields plus a lowercase `errorCode` (1–60 characters, letters/numbers/underscores): records a terminal processing failure, clears the lease, or marks the job cancelled if cancellation was requested. Expired or stale leases are rejected.
- `POST /internal/processor/complete` with lease fields and optional `title` (up to 200 characters): marks an owned active job completed with progress 100 and clears its lease. It rejects stale/expired leases and jobs with cancellation requested. This callback records job completion only; media registration/download remains a later milestone.

The Worker stores only SHA-256 of the lease token. A lease is valid only for its job and lease ID. Expired processing jobs are requeued until `max_attempts` is reached, then marked failed. Expired jobs with a cancellation request become cancelled. The initial Python client is a connectivity/claim smoke test and releases jobs; it does not process media.

## Job states
`queued` → `processing` → `review` → `completed`; failures and cancellation transition to `failed` or `cancelled`. A processing job can expose stage `cancellation_requested` until the worker acknowledges cancellation or its lease expires.

## Infrastructure status
R2 is bound privately but media upload/signing and clip download routes remain future work. No Cloudflare resources are created or deployed by the code changes.

## Security rules
- Resource IDs are not permissions; authorize every user-facing request by authenticated user ID.
- Processor endpoints require timestamped, one-time-nonce HMAC authentication and a per-job lease token.
- Validate source URLs again in the processor, including redirect/DNS/IP checks, before any future network fetch.
- Enforce source duration, file-size and scratch-space limits.
- Make processor stages retry-safe/idempotent.
- Keep provider keys and processor shared secrets server-side.
- Never expose raw provider errors.
- Use private R2 objects and short-lived authorized download URLs.
- Process only media the account owner has permission to use; do not bypass platform access controls.


## Authorized source asset upload

A URL job is created in `review` with stage `awaiting_source_asset`. It cannot be claimed by the processor until a ready private source asset has been attached. The account owner must upload an original/export or another provider-approved file that they have permission to process. Public platform metadata is not a media download grant and does not establish ownership.

- `POST /api/source-assets` initializes a multipart upload using `filename`, `contentType`, and `sizeBytes`. Supported declared formats are MP4, MOV, WebM, and Matroska. The API returns an asset ID, expected part count, and an 8 MiB part size. R2 upload IDs and object keys remain server-side.
- `PUT /api/source-assets/:assetId/parts/:partNumber` accepts one raw binary part. `Content-Length` must equal the exact expected size for that part.
- `GET /api/source-assets/:assetId` returns the authenticated user's asset state and uploaded part numbers, allowing the client to resume missing parts.
- `POST /api/source-assets/:assetId/complete` finalizes only when every expected part exists and all part sizes match.
- `POST /api/jobs/:jobId/source-asset` attaches a ready asset only when the asset owner and job owner are the same. Each asset can be attached to at most one job. This transitions the job to `queued`.
- `GET /api/source-assets` lists only the authenticated user's assets. `DELETE /api/source-assets/:assetId` removes unattached or inactive assets.

Limits are 2 GiB per file and 8 GiB per account across uploading/ready source assets. R2 objects use server-generated owner-scoped keys. The processor claims only jobs with a ready, owner-matched source asset; after official metadata confirms a VOD, `POST /internal/processor/source-ready` moves the job to `review` / `source_ready` and clears its lease. Live/upcoming sources remain unsupported by the VOD pipeline.

The declared MIME type and filename are not proof of the actual file format. Processor-side R2 retrieval, FFprobe validation, audio extraction, transcription, AI moment detection, rendering, and frontend upload integration remain future work. No Cloudflare resources are created or deployed by this code change.
