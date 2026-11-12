# ClipForge API

Cloudflare Worker API for the private two-account ClipForge workspace.

## Implemented foundation
- Cloudflare Access JWT verification (signature, issuer and audience).
- Explicit allowlist for exactly two configured email addresses.
- D1 user provisioning from verified Access identities.
- User-scoped URL job creation, listing, status and cancellation.
- Bulk URL submission (up to 20 unique YouTube/Twitch URLs per request).
- D1-backed processor job claiming with expiring leases and attempt limits.
- HMAC-authenticated, replay-protected processor ping, claim, heartbeat, progress, release and failure endpoints.
- Cancellation requests remain visible to an active processor through heartbeat responses.
- Private R2 binding reserved for subsequent media upload/export routes.

D1 is the single source of truth for dispatch. There is no Cloudflare Queue producer in this polling architecture. The API does not download arbitrary URLs; source type stays `unknown` until a supported, authorized source adapter detects live versus VOD.

## Processor API contract

All `/internal/processor/*` routes require:
- `X-Processor-Timestamp`: Unix seconds, within five minutes of Worker time.
- `X-Processor-Signature`: lowercase/uppercase hex HMAC-SHA256 of the canonical bytes:
  `timestamp + "\n" + HTTP method + "\n" + URL pathname + "\n" + exact raw request body`.
- HMAC key: the Worker secret `PROCESSOR_SHARED_SECRET`.

Routes:
- `POST /internal/processor/ping` — authenticated connectivity check; body `{}`.
- `POST /internal/processor/claim` — body `{"workerId":"processor-1"}`; atomically claims the oldest queued job. Returns `{ "job": null }` when idle, otherwise job data plus a one-time lease token.
- `POST /internal/processor/heartbeat` — body `{"jobId":"...","leaseId":"...","leaseToken":"..."}`; extends the 90-second lease and returns `cancelRequested`.
- `POST /internal/processor/progress` — same lease fields plus `stage` and integer `progress` (0–99).
- `POST /internal/processor/release` — releases a claimed job back to queued for safe connection tests; if cancellation was requested, it becomes cancelled.

The processor must keep the lease token private. D1 stores only its SHA-256 hash. A stale lease is recovered on the next claim request; attempts are bounded by `max_attempts` (default 3). The first Python milestone deliberately claims, heartbeats, reports a test stage and releases a job. It does not download or process source media.

## Configure before deployment
1. Create a Cloudflare Access application protecting the frontend/API and permit only the two intended users.
2. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the two exact `ALLOWED_EMAILS` in Wrangler vars.
3. Create D1 database `clipforge-db` and private R2 bucket `clipforge-private-media`.
4. Replace the D1 database ID in `wrangler.toml`.
5. Set the processor secret with `wrangler secret put PROCESSOR_SHARED_SECRET`; use the same high-entropy value in the processor's `PROCESSOR_SHARED_SECRET` environment variable. Never commit it.
6. Install API dependencies and run `npm run typecheck`.
7. Apply migrations with `wrangler d1 migrations apply clipforge-db --remote`.

Do not deploy with placeholder Access values or D1 ID. No cloud resources are created by this repository change.

## Endpoints
- `GET /health` — unauthenticated API health check.
- `GET /api/me` — authenticated identity.
- `POST /api/jobs` — `{ "urls": ["https://..."], "options": { "captions": true, "vertical": true, "instruction": "..." } }`.
- `GET /api/jobs` — current user's jobs.
- `GET /api/jobs/:jobId` — current user's job status.
- `POST /api/jobs/:jobId/cancel` — request cancellation of one owned job.
- `POST /api/jobs/cancel-all` — request cancellation of active jobs for the current user.
- `GET /api/clips` — current user's clips.

## Not yet operational
The Python/FFmpeg media pipeline, source adapters, live/VOD detection, transcription, AI analysis, clip rendering, R2 upload/download routes, frontend API integration and deployment resources are not implemented/configured yet. Do not interpret a successful processor connectivity test as a working video clipper.
