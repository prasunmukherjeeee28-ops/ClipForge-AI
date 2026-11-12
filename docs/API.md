# ClipForge API

Authenticated JSON API behind Cloudflare Access. Every resource query must be scoped to the verified user identity.

## Authentication and access
- Cloudflare Access protects the application/API and validates the user's session.
- The Worker independently verifies the `Cf-Access-Jwt-Assertion` signature, issuer and audience.
- An explicit `ALLOWED_EMAILS` allowlist limits access to the two intended accounts.
- Verified Access subjects are provisioned into D1. User IDs are never accepted from request bodies.
- Configure exactly two email addresses before deployment. Do not use public registration.

## Health
- `GET /health` — service status; no secrets.

## Identity
- `GET /api/me` — authenticated user identity.

## Jobs
- `POST /api/jobs` — create 1–20 jobs in one request:
  `{ "urls": ["https://..."], "options": { "captions": true, "vertical": true, "reviewScores": true, "instruction": "..." } }`
- `GET /api/jobs` — list the current user's jobs.
- `GET /api/jobs/:jobId` — status/progress for an owned job.
- `POST /api/jobs/:jobId/cancel` — cancel one owned queued/processing job.
- `POST /api/jobs/cancel-all` — cancel all active jobs for the current user.

Only HTTPS YouTube and Twitch URL hostnames are accepted. This validation does not download the URL or establish media access. The source type remains `unknown` until an authorized source adapter detects live versus VOD.

## Clips
- `GET /api/clips` — list the current user's clip metadata.

## Job states
`queued` → `processing` → `review` → `completed`; failures and cancellation transition to `failed` or `cancelled`.

## Infrastructure status
The API currently creates D1 job records and publishes queue messages. The queue producer is configured; do not attach a consumer until the separate processor service is deployed and authenticated. R2 is bound privately but media upload/signing and clip download routes are a subsequent implementation step.

## Security rules
- Resource IDs are not permissions; authorize every request by authenticated user ID.
- Validate source URLs and enforce batch limits.
- Make processor operations retry-safe/idempotent.
- Keep provider keys and processor shared secrets server-side.
- Never expose raw provider errors.
- Use private R2 objects and short-lived authorized download URLs.
- Process only media the account owner has permission to use; do not bypass platform access controls.
