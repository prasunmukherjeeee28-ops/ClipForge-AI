# Video processor

Runs outside Cloudflare Workers because FFmpeg and long-running video work require a dedicated runtime.

Planned pipeline:
- Consume queued jobs
- Fetch authorized media from private R2
- Transcribe audio when available
- Produce timestamp candidates for human review
- Cut selected moments with FFmpeg; optionally caption and render 9:16
- Upload exports and update D1 job status

Processing must be retry-safe, bounded by file/duration limits, and observable. Refer to `docs/ARCHITECTURE.md`.