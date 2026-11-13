# ClipForge AI — Web

Frontend for ClipForge AI. React + TypeScript + Vite + Tailwind CSS.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

## Structure

```
src/
  components/
    ui/        reusable primitives (button, card, dialog, badge, …)
    layout/    app shell: sidebar, topbar
    video/     procedural thumbnails + preview monitor
  features/    one folder per screen: dashboard, upload, library, editor, live-radar, settings
  hooks/
  lib/         types (aligned with docs/API.md), utils, mock data
  pages/
  App.tsx      hash router + routes
```

## Backend integration status

The upload screen now uses the real authenticated API contract for:
- Creating a URL job that waits for a creator-authorized source asset.
- Uploading a local MP4, MOV, WebM or MKV file to private R2 with resumable 8 MiB multipart chunks.
- Resuming already-confirmed parts, finalizing the private object and attaching it to the current user's job.

The API client uses relative `/api` paths by default. Set
`VITE_CLIPFORGE_API_BASE_URL` at build time only when the API is mounted at a
compatible origin. The current Worker does not configure cross-origin CORS, so
the intended deployment is a same-origin API route protected by Cloudflare
Access. Both user accounts must be separately allowlisted on the Access app.

This is an ingestion stage, not a finished clipping pipeline. The processor
currently verifies official YouTube/Twitch VOD metadata and moves an eligible
job to `source_ready`; it does not yet read the R2 file, validate its contents
with FFprobe, transcribe, detect moments, render clips, or produce downloads.
Dashboard, library, editor and Live Radar screens still contain fixture data.
Do not interpret sample dashboard/library entries as real user clips.

Upload previews use a local object URL of the selected file. Editor/radar
playback remains a UI placeholder until real clip media endpoints are added.
