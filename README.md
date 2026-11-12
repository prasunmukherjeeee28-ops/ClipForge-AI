# ClipForge AI

**Find the moment. Forge the clip.**

Private video clipping workspace for exactly two trusted users. Process only media you own or are authorized to use.

## Stack
- React + TypeScript + Vite + Tailwind (web)
- Cloudflare Workers + Hono (API)
- Cloudflare D1 (metadata and D1-backed job dispatch), R2 (private media)
- Python + FFmpeg (separate video processor)
- AI transcription + analysis (provider-agnostic)

## MVP milestones
1. UI shell: dashboard, upload, clip library, settings
2. Authentication, D1 job state, private R2
3. Python processor polling, transcription, moment candidates and FFmpeg clipping
4. Subtitles, 9:16 exports, review scores
5. Live Radar for authorized sources

D1 is the single source of truth for job dispatch. The Python processor claims jobs through timestamped HMAC-authenticated Worker API endpoints; Cloudflare Queues are not part of the current design.

See `docs/ARCHITECTURE.md` and `docs/API.md`.
