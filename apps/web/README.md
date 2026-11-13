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

The upload screen uses the authenticated API to create jobs, upload creator-authorized source files to private R2 with resumable multipart chunks, and attach the completed source asset to the user's job.

The dashboard, processing activity and clip library now read the current account's data from:
- `GET /api/jobs` for source processing state and progress.
- `GET /api/clips` for finished clip metadata.
- `GET /api/clips/:clipId/preview` for authenticated byte-range MP4 playback.
- `GET /api/clips/:clipId/download` for authenticated MP4 downloads.

The library refreshes job and clip data periodically, shows active job progress, supports cancellation, and previews/downloads clips without exposing public R2 object URLs. The dashboard displays live account-scoped counts and recent jobs/clips. Empty states are based on the authenticated API response rather than sample clips.

The API client uses relative `/api` paths by default. Set
`VITE_CLIPFORGE_API_BASE_URL` at build time only when the API is mounted at a
compatible origin. The Worker does not configure cross-origin CORS; the intended
deployment is a same-origin API route protected by Cloudflare Access. Both user
accounts must be separately allowlisted on the Access app.

The editor's candidate-trimming controls and Live Radar still contain presentation/demo behavior and are not connected to editable source media or live-stream ingestion. The backend currently creates finished clips automatically; it does not yet support destructive clip deletion or post-render re-editing. Do not interpret old fixture data in those remaining screens as real user assets.
