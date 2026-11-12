/**
 * Domain types aligned with docs/API.md and database/schema.sql.
 * These mirror the planned backend contracts so the UI layer can be
 * wired to the real API later without reshaping feature code.
 */

export type JobStatus = "queued" | "processing" | "review" | "completed" | "failed";

export type JobStage =
  | "uploading"
  | "transcribing"
  | "analyzing"
  | "finding_moments"
  | "rendering"
  | "done";

export interface Project {
  id: string;
  title: string;
  sourceDurationSec: number;
  status: JobStatus;
  createdAt: string;
  clipCount: number;
  thumbHue: number;
}

export interface Clip {
  id: string;
  projectId: string;
  title: string;
  durationSec: number;
  aspect: "16:9" | "9:16" | "1:1";
  status: "ready" | "processing" | "draft";
  createdAt: string;
  score: number; // 0-100 review score estimate
  thumbHue: number;
  captions: boolean;
}

export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  time: string;
  stage: JobStage | "info";
  progress: number; // 0-100
}

export interface CandidateMoment {
  id: string;
  startSec: number;
  endSec: number;
  title: string;
  hookScore: number;
  contextScore: number;
  payoffScore: number;
  reason: string;
  transcript: string;
}

export interface StreamSource {
  id: string;
  name: string;
  platform: "twitch" | "youtube" | "custom";
  status: "live" | "offline";
  viewers: number;
  uptimeSec: number;
}

export interface RadarMoment {
  id: string;
  streamId: string;
  atSec: number;
  title: string;
  intensity: number; // 0-100
  kind: "hype" | "clip_spike" | "quote";
}
