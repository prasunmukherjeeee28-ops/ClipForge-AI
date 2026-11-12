/**
 * MOCK DATA — clearly separated from real backend integration.
 *
 * The backend (Cloudflare Worker API per docs/API.md) is not implemented yet,
 * so these fixtures stand in for `GET /api/clips`, `GET /api/jobs/:id`, etc.
 * Replace the functions in `src/lib/api.ts` with real fetches when the API ships.
 * Scores are illustrative estimates only, matching the architecture doc:
 * "Scores are estimates, never guarantees of virality; human review is required."
 */

import type {
  ActivityItem,
  CandidateMoment,
  Clip,
  Project,
  RadarMoment,
  StreamSource,
} from "./types";

export const mockProjects: Project[] = [
  {
    id: "prj_01",
    title: "Q3 Product Keynote — Full Stream",
    sourceDurationSec: 5340,
    status: "review",
    createdAt: "2026-11-10T14:32:00Z",
    clipCount: 6,
    thumbHue: 262,
  },
  {
    id: "prj_02",
    title: "Podcast Ep. 42 — Growth AMA",
    sourceDurationSec: 7260,
    status: "completed",
    createdAt: "2026-11-08T09:12:00Z",
    clipCount: 11,
    thumbHue: 288,
  },
  {
    id: "prj_03",
    title: "Dev Workshop: Edge Functions",
    sourceDurationSec: 4980,
    status: "processing",
    createdAt: "2026-11-11T18:04:00Z",
    clipCount: 0,
    thumbHue: 250,
  },
  {
    id: "prj_04",
    title: "Community Town Hall — Oct",
    sourceDurationSec: 6180,
    status: "completed",
    createdAt: "2026-10-29T19:44:00Z",
    clipCount: 4,
    thumbHue: 276,
  },
];

export const mockClips: Clip[] = [
  { id: "clip_01", projectId: "prj_02", title: "“We almost ran out of runway”", durationSec: 44, aspect: "9:16", status: "ready", createdAt: "2026-11-08T10:02:00Z", score: 91, thumbHue: 290, captions: true },
  { id: "clip_02", projectId: "prj_02", title: "The pricing mistake that cost us $40k", durationSec: 58, aspect: "9:16", status: "ready", createdAt: "2026-11-08T10:14:00Z", score: 87, thumbHue: 268, captions: true },
  { id: "clip_03", projectId: "prj_01", title: "Keynote: the one-slide product reveal", durationSec: 37, aspect: "16:9", status: "ready", createdAt: "2026-11-10T15:01:00Z", score: 84, thumbHue: 255, captions: false },
  { id: "clip_04", projectId: "prj_02", title: "Why we killed the mobile app", durationSec: 92, aspect: "1:1", status: "ready", createdAt: "2026-11-08T11:30:00Z", score: 78, thumbHue: 300, captions: true },
  { id: "clip_05", projectId: "prj_04", title: "Roadmap teaser — what ships in December", durationSec: 41, aspect: "9:16", status: "ready", createdAt: "2026-10-29T20:10:00Z", score: 76, thumbHue: 246, captions: true },
  { id: "clip_06", projectId: "prj_01", title: "Founder story: the first 100 users", durationSec: 63, aspect: "9:16", status: "processing", createdAt: "2026-11-11T09:20:00Z", score: 0, thumbHue: 262, captions: true },
  { id: "clip_07", projectId: "prj_04", title: "Audience Q&A: churn deep-dive", durationSec: 118, aspect: "16:9", status: "ready", createdAt: "2026-10-29T21:05:00Z", score: 71, thumbHue: 282, captions: false },
  { id: "clip_08", projectId: "prj_02", title: "The cold-email framework", durationSec: 49, aspect: "9:16", status: "ready", createdAt: "2026-11-08T12:44:00Z", score: 69, thumbHue: 272, captions: true },
];

export const mockActivity: ActivityItem[] = [
  { id: "act_1", label: "Finding moments", detail: "Dev Workshop: Edge Functions", time: "2m ago", stage: "finding_moments", progress: 62 },
  { id: "act_2", label: "Rendering clip", detail: "“Founder story: the first 100 users”", time: "18m ago", stage: "rendering", progress: 84 },
  { id: "act_3", label: "Transcribing", detail: "Q3 Product Keynote — Full Stream", time: "1h ago", stage: "transcribing", progress: 100 },
  { id: "act_4", label: "Analysis complete", detail: "Podcast Ep. 42 — 11 candidates found", time: "3h ago", stage: "info", progress: 100 },
];

export const mockCandidates: CandidateMoment[] = [
  {
    id: "cand_1",
    startSec: 482,
    endSec: 531,
    title: "The infra bill shock moment",
    hookScore: 94,
    contextScore: 81,
    payoffScore: 88,
    reason: "Strong emotional spike + clear setup/payoff arc in transcript.",
    transcript: "— and that’s when we opened the invoice and realized we were paying more for logs than for rent.",
  },
  {
    id: "cand_2",
    startSec: 1240,
    endSec: 1302,
    title: "Live demo failure recovery",
    hookScore: 88,
    contextScore: 79,
    payoffScore: 92,
    reason: "Demo breaks, speaker recovers gracefully — high retention pattern.",
    transcript: "Okay, that did not go as planned. Let me show you exactly what just failed and why it’s actually a feature.",
  },
  {
    id: "cand_3",
    startSec: 2110,
    endSec: 2151,
    title: "The contrarian hot take",
    hookScore: 91,
    contextScore: 64,
    payoffScore: 70,
    reason: "Polarizing statement drives comments; weaker context, trim start.",
    transcript: "Everyone says ship fast. I think that advice is destroying your product.",
  },
  {
    id: "cand_4",
    startSec: 3422,
    endSec: 3488,
    title: "Customer story with numbers",
    hookScore: 76,
    contextScore: 90,
    payoffScore: 85,
    reason: "Concrete numbers and a named customer — strong credibility beat.",
    transcript: "They went from forty-minute deploys to eleven seconds. Here’s the exact change they made.",
  },
];

export const mockStreams: StreamSource[] = [
  { id: "str_1", name: "founders-live — Twitch", platform: "twitch", status: "live", viewers: 1284, uptimeSec: 7420 },
  { id: "str_2", name: "product-ama — YouTube", platform: "youtube", status: "live", viewers: 356, uptimeSec: 1980 },
  { id: "str_3", name: "dev-office-hours", platform: "custom", status: "offline", viewers: 0, uptimeSec: 0 },
];

const radarTimeline: RadarMoment[] = Array.from({ length: 42 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const intensity = Math.round(r(1) * 100);
  return {
    id: `rad_${i}`,
    streamId: i % 3 === 0 ? "str_2" : "str_1",
    atSec: i * 180,
    title: "",
    intensity,
    kind: intensity > 80 ? "hype" : intensity > 55 ? "clip_spike" : "quote",
  };
});

// Label only the strongest moments so candidate cards stay meaningful.
radarTimeline.forEach((m, i) => {
  if (m.intensity > 78) {
    m.title = [
      "Chat erupts after the reveal",
      "Guest drops an unfiltered take",
      "Perfect one-liner reaction",
      "Audience poll spike",
      "Clip-worthy callback",
      "Hype train milestone",
    ][i % 6];
  }
});

export const mockRadarTimeline = radarTimeline;

export const mockRadarCandidates: RadarMoment[] = radarTimeline
  .filter((m) => m.intensity > 78 && m.title)
  .slice(0, 6);
