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

The Cloudflare Worker API (see `docs/API.md`) is not implemented yet. All
screen content comes from clearly-marked fixtures in `src/lib/mock-data.ts`;
domain types in `src/lib/types.ts` mirror the planned API contracts so real
fetch calls can replace the mocks without reshaping feature code.

Intentionally **not** simulated: real AI results, real video processing, real
media playback (upload previews use a local object URL of your own file;
editor/radar playback moves a cursor only).
