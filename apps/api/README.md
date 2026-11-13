# ClipForge API

Cloudflare Worker API for the private two-account ClipForge workspace.

## Runtime responsibilities

- Cloudflare Access JWT verification, issuer/audience validation and an explicit two-email allowlist.
- D1-backed user provisioning, job state, source metadata, upload parts, processor leases, candidates and clip records.
- Owner-scoped multipart uploads of creator-authorized source files to private object storage.
- Atomic processor job claiming from D1; D1 is the only dispatch source (no Cloudflare Queue).
- HMAC-SHA256 authenticated processor endpoints with a five-minute timestamp window and one-use nonce.
- Lease-checked source streaming from private object storage to the processor.
- Lease-bound moment persistence, clip multipart upload, Backblaze B2 object storage object-size verification and D1 clip registration.
- Owner-scoped clip listing, preview and download. Backblaze B2 object storage objects are not public.

The API never downloads submitted YouTube/Twitch pages or extracts platform playback URLs. A URL is used for official metadata inspection only. The user must provide an original/export or other provider-approved media file they are authorized to process.

## User-facing endpoints

- `GET /health` — unauthenticated API health.
- `GET /api/me` — authenticated account identity.
- `POST /api/jobs` — submit one or more supported source URLs (up to 20 unique URLs per request).
- `GET /api/jobs` — list only the current user's jobs.
- `GET /api/jobs/:jobId` — read one owned job.
- `POST /api/jobs/:jobId/cancel` — request cancellation of one owned job.
- `POST /api/jobs/cancel-all` — request cancellation of the current user's active jobs.
- `POST /api/source-assets` and its upload/complete routes — create, upload and finalize an owner-scoped source asset.
- `POST /api/jobs/:jobId/source-asset` — attach a ready source asset owned by the same user to the job.
- `GET /api/jobs/:jobId/moments` — list moment candidates for one owned job.
- `GET /api/clips` — list only the current user's finished clips.
- `GET /api/clips/:clipId/preview` — stream an owned private clip with byte-range support.
- `GET /api/clips/:clipId/download` — download an owned private MP4.

## Processor API contract

All `/internal/processor/*` routes require:

- `X-Processor-Timestamp`: Unix seconds, within five minutes of Worker time.
- `X-Processor-Nonce`: a fresh 32-character hexadecimal nonce per request.
- `X-Processor-Signature`: HMAC-SHA256 over the exact canonical request bytes:
  `timestamp + "\\n" + lowercase_nonce + "\\n" + HTTP method + "\\n" + URL pathname + "\\n" + exact raw body`.
- The Worker stores only a hash of each nonce and rejects replays.
- HMAC key: Worker secret `PROCESSOR_SHARED_SECRET`.

The Python client implements the same signing contract. The raw lease token is returned only when a job is claimed; D1 stores its SHA-256 hash. Do not log or commit the token or shared secret.

Processor routes cover authenticated ping, claim, heartbeat, progress, source metadata verification, private source streaming, media/transcript/candidate persistence, lease-scoped clip multipart uploads, final clip registration, release and failure callbacks. Every mutating job operation is checked against the current lease ID, token hash, job state and expiry.

## Two-account isolation

Set `ALLOWED_EMAILS` to exactly the two intended Cloudflare Access email identities. Do not place the app behind an open sign-up flow. User-facing D1 reads and writes derive the user ID from the verified Access identity; clients never choose their own user ID. Source assets, jobs, candidates, clips and Backblaze B2 object storage object keys are owner-scoped.

## Cloudflare configuration

The Worker serves both the Vite frontend (`apps/web/dist`) and the Hono API from the same origin using Worker Static Assets. This keeps Cloudflare Access session handling same-origin; the API's public base URL can remain empty in the web build. `npm run deploy` in `apps/api` builds the frontend first, then deploys the Worker. Before deploying:

1. Use the existing `clipforge-app-db` D1 database; its ID is configured in `wrangler.toml`.
2. Enable Backblaze B2 object storage and create a private bucket named `clipforge-private-media` (do not enable public access or an `r2.dev` URL). Create a bucket-restricted S3 application key, not the master key. The adapter needs `readFiles`, `writeFiles`, and `deleteFiles`. Backblaze documents `writeFiles` as enabling S3 multipart create/upload/complete/abort calls. Its app-key guidance also says bucket-restricted keys need `listAllBucketNames` for SDK/integration compatibility; include `listBuckets` as well so the integration can distinguish missing-object responses from access-denied responses. Do not grant `listFiles`, bucket-write, or bucket-delete permissions unless a later feature explicitly requires them. Keep the key scoped to this one bucket and verify the exact permission set with the private-bucket smoke test before production.
3. Configure a Cloudflare Access application for the app/API and restrict it to the two intended users.
4. Replace `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ALLOWED_EMAILS` placeholders with the actual Access team domain, application audience and two email addresses.
5. Set the Worker secret `PROCESSOR_SHARED_SECRET` to a random value of at least 32 characters. Supply the same value only to the private processor host.
6. The nine migrations have already been applied to `clipforge-app-db`; verify the remote migration list before making schema changes.
7. Run `npm install` and `npm run typecheck` in this directory. Set the two configured email identities and Access values without committing private addresses or secrets. Then run `npm run deploy` only after all bindings, secrets and Access settings are correct.

Do not deploy with placeholder Access settings. Keep Backblaze B2 object storage private. B2 buckets are versioned: a normal S3 `DeleteObject` creates a delete marker rather than immediately erasing every older version. Configure a lifecycle rule to expire noncurrent versions after a short retention period (for example, one day) and abort incomplete multipart uploads after a short period. Treat app-level deletion as immediately hidden from users, but not as immediate physical erasure until the lifecycle policy runs. Never put credentials in this file, `wrangler.toml`, GitHub source, frontend variables or a committed environment file.

## Processor deployment

The separate Python processor has its own Docker image and single-instance Compose service. See `services/processor/README.md`. The processor is deliberately not deployed as a Cloudflare Worker because FFmpeg and faster-whisper require a normal Linux runtime and persistent local scratch/model storage.

## Current cloud setup status

Cloudflare setup has begun, but the app is not deployed. The dedicated `clipforge-app-db` D1 database has been created in APAC and migrations `0001` through `0009` have been applied. The legacy `clipforge-db` database was left untouched. Cloudflare R2 activation was unavailable, so the project switched to Backblaze B2; B2 is not yet enabled for this project and no bucket or application key has been created. No `clipforge-api` Worker is deployed. The previously existing `morrow-backend` Worker was deleted with authorization; no other Workers were changed.

Cloudflare Access is not yet configured for the two identities, the processor host has not been selected, and no end-to-end media job has been run. The app is not operational until a private B2 bucket and restricted application key are configured, Access is restricted to exactly the two intended accounts, the Worker and processor are deployed, and an authorized media job succeeds through private clip download.
