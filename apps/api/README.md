# ClipForge API

Cloudflare Worker API for the private two-account ClipForge workspace.

## Current scope
- Cloudflare Access JWT authentication and an explicit two-email allowlist.
- User records provisioned from verified Access identities.
- User-scoped job creation, listing, status and cancellation.
- Bulk URL submission (up to 20 unique YouTube/Twitch URLs per request).
- D1 metadata and Cloudflare Queues orchestration.
- Processor service binding for asynchronous media work.
- Clip metadata listing.

The API deliberately does not download arbitrary URLs. The processor must use supported, authorized source integrations or user-provided media. URL parsing is not proof that the linked media is accessible.

## Configure before deployment
1. Create a Cloudflare Access self-hosted application protecting the frontend/API and permit only the two intended users.
2. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the two exact `ALLOWED_EMAILS` in Wrangler vars.
3. Create D1 database `clipforge-db`, private R2 bucket `clipforge-private-media`, Queue `clipforge-jobs`, and dead-letter Queue `clipforge-jobs-dlq`.
4. Replace the D1 database ID in `wrangler.toml`.
5. Configure `PROCESSOR_SHARED_SECRET` with `wrangler secret put PROCESSOR_SHARED_SECRET` and deploy the processor service before enabling the service binding.
6. Apply migrations with `wrangler d1 migrations apply clipforge-db --remote`.
7. Install dependencies and run `npm run typecheck`.

Do not commit credentials, Access tokens, or provider API keys.

## Endpoints
- `GET /health` — unauthenticated health check.
- `GET /api/me` — authenticated identity.
- `POST /api/jobs` — `{ "urls": ["https://..."], "options": { "captions": true, "vertical": true, "instruction": "..." } }`.
- `GET /api/jobs` — current user's jobs.
- `GET /api/jobs/:jobId` — current user's job status.
- `POST /api/jobs/:jobId/cancel` — cancel one job.
- `POST /api/jobs/cancel-all` — cancel all active jobs for the current user.
- `GET /api/clips` — current user's clips.

Every resource query is scoped to the authenticated user. D1 IDs are never treated as authorization.
