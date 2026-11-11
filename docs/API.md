# ClipForge API Plan

Authenticated JSON API except minimal health check.

## Health
- `GET /health` — service status; no secrets.

## Uploads/jobs
- `POST /api/uploads` — create upload record and return upload instructions.
- `POST /api/jobs` — start processing for an uploaded source.
- `GET /api/jobs/:jobId` — status/progress.
- `GET /api/jobs/:jobId/candidates` — candidate moments for review.
- `POST /api/jobs/:jobId/candidates/:candidateId/select` — request rendering.

## Clips
- `GET /api/clips` — list clips.
- `GET /api/clips/:clipId` — metadata and authorized playback URL.
- `PATCH /api/clips/:clipId` — edit title/review metadata.
- `DELETE /api/clips/:clipId` — delete metadata/media according to retention policy.

## Job states
`queued` → `processing` → `review` → `completed`; failures transition to `failed`.

## Rules
- Resource IDs are not permissions; authorize each request.
- Validate inputs and enforce upload limits.
- Make jobs retry-safe/idempotent.
- Never expose provider keys or raw provider errors.
- Use short-lived signed URLs or authenticated media delivery.