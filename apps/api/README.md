# ClipForge API

Cloudflare Worker API for the private two-account ClipForge workspace.

## Implemented foundation
- Cloudflare Access JWT verification (signature, issuer and audience).
- Explicit allowlist for exactly two configured email addresses.
- D1 user provisioning from verified Access identities.
- User-scoped URL job creation, listing, status and cancellation.
- Bulk URL submission (up to 20 unique YouTube/Twitch URLs per request).
- D1 metadata and Cloudflare Queues producer.
- Private R2 binding reserved for subsequent media upload/export routes.

The API deliberately does not download arbitrary URLs. The source type stays `unknown` until a supported, authorized source adapter detects live versus VOD.

## Not yet operational
The Python/FFmpeg processor, queue consumer, media ingestion, R2 upload/download routes, AI providers, frontend API integration and deployment resources are not implemented/configured yet. The queue producer can enqueue work, but a queue consumer must not be enabled until the processor endpoint exists.

## Configure before deployment
1. Create a Cloudflare Access application protecting the frontend/API and permit only the two intended users.
2. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the two exact `ALLOWED_EMAILS` in Wrangler vars.
3. Create D1 database `clipforge-db`, private R2 bucket `clipforge-private-media`, and Queue `clipforge-jobs`.
4. Replace the D1 database ID in `wrangler.toml`.
5. Install dependencies and run `npm run typecheck`.
6. Apply migrations with `wrangler d1 migrations apply clipforge-db --remote`.

Do not commit credentials, Access tokens, or provider API keys. Do not deploy with placeholder Access values or D1 ID.

## Endpoints
- `GET /health` — unauthenticated health check.
- `GET /api/me` — authenticated identity.
- `POST /api/jobs` — `{ "urls": ["https://..."], "options": { "captions": true, "vertical": true, "instruction": "..." } }`.
- `GET /api/jobs` — current user's jobs.
- `GET /api/jobs/:jobId` — current user's job status.
- `POST /api/jobs/:jobId/cancel` — cancel one job.
- `POST /api/jobs/cancel-all` — cancel all active jobs for the current user.
- `GET /api/clips` — current user's clips.
