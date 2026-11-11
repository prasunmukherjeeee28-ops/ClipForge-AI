# ClipForge AI

**Find the moment. Forge the clip.**

Private video clipping workspace for a small trusted group. Process only media you own or are authorized to use.

## Stack
- React + TypeScript + Vite + Tailwind (web)
- Cloudflare Workers + Hono (API)
- Cloudflare D1 (metadata), R2 (private media), Queues (jobs)
- Python + FFmpeg (separate video processor)
- AI transcription + analysis (provider-agnostic)

## MVP milestones
1. UI shell: dashboard, upload, clip library, settings
2. Authentication, uploads, D1, private R2
3. Transcription, moment candidates, FFmpeg clipping
4. Subtitles, 9:16 exports, review scores
5. Live Radar for authorized sources

See `docs/ARCHITECTURE.md` and `docs/API.md`.