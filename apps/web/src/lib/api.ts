const API_BASE = getApiBase();

import { getApiBase, getMobileSessionToken, isNativePlatform } from "./platform";

function apiPath(path: string): string {
  return isNativePlatform() ? path.replace(/^\/api(?=\/|$)/, "/mobile/v1/api") : path;
}

export interface CurrentUser {
  id: string;
  email: string;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface JobSubmission {
  id: string;
  status: "review";
  stage: "awaiting_source_asset";
  sourcePlatform: "youtube" | "twitch";
}

export interface SourceAssetUpload {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading";
  partSizeBytes: number;
  partCount: number;
}

export interface SourceAssetState {
  asset: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    status: "uploading" | "finalizing" | "ready" | "failed" | "deleting";
  };
  uploadedParts: Array<{ partNumber: number; sizeBytes: number }>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const native = isNativePlatform();
  const token = native ? await getMobileSessionToken() : null;
  if (native && !token) {
    throw new ApiRequestError("Sign in to your private ClipForge account first.", 401);
  }

  const headers = new Headers(init.headers);
  if (!(init.body instanceof Blob) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", "Bearer " + token);

  const response = await fetch(API_BASE + apiPath(path), {
    ...init,
    credentials: native ? "omit" : "include",
    headers,
  });
  const raw = await response.text();
  let payload: ({ error?: { message?: string } } & Record<string, unknown>) | null = null;
  try {
    payload = raw ? JSON.parse(raw) as typeof payload : null;
  } catch {
    if (raw.trimStart().startsWith("<")) {
      throw new Error("ClipForge returned an HTML page instead of API data. Check the app's API connection and Cloudflare mobile access route.");
    }
  }

  if (!response.ok) {
    const message = payload && typeof payload.error === "object"
      ? payload.error?.message
      : undefined;
    throw new ApiRequestError(message || "ClipForge API request failed (" + response.status + ").", response.status);
  }

  if (payload === null) {
    throw new Error("ClipForge API returned an empty or unreadable response.");
  }
  return payload as T;
}

export async function getCurrentUser(inviteCode?: string): Promise<CurrentUser> {
  const result = await request<{ user: CurrentUser }>("/api/me", inviteCode
    ? { headers: { "X-ClipForge-Invite": inviteCode.trim() } }
    : {});
  if (!result.user?.id || !result.user.email) {
    throw new Error("The ClipForge API returned an incomplete account identity.");
  }
  return result.user;
}

export async function createSourceJob(sourceUrl: string): Promise<JobSubmission> {
  const result = await request<{ jobs: JobSubmission[] }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ urls: [sourceUrl] }),
  });
  if (!result.jobs?.[0]?.id) throw new Error("The API did not create a source job.");
  return result.jobs[0];
}

export async function createSourceAsset(file: File): Promise<SourceAssetUpload> {
  const result = await request<{ asset: SourceAssetUpload }>("/api/source-assets", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });
  if (!result.asset?.id || !result.asset.partSizeBytes || !result.asset.partCount) {
    throw new Error("The API returned an incomplete source upload session.");
  }
  return result.asset;
}

export async function getSourceAsset(assetId: string): Promise<SourceAssetState> {
  return request<SourceAssetState>(`/api/source-assets/${encodeURIComponent(assetId)}`);
}

export async function uploadSourcePart(
  assetId: string,
  partNumber: number,
  part: Blob,
): Promise<void> {
  await request<{ uploaded: boolean }>(
    `/api/source-assets/${encodeURIComponent(assetId)}/parts/${partNumber}`,
    {
      method: "PUT",
      body: part,
      headers: { "Content-Type": "application/octet-stream" },
    },
  );
}

export async function completeSourceAsset(assetId: string): Promise<void> {
  await request<{ status: "ready" }>(
    `/api/source-assets/${encodeURIComponent(assetId)}/complete`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function attachSourceAsset(jobId: string, assetId: string): Promise<void> {
  await request<{ status: "queued" }>(
    `/api/jobs/${encodeURIComponent(jobId)}/source-asset`,
    { method: "POST", body: JSON.stringify({ sourceAssetId: assetId }) },
  );
}

export async function cancelSourceJob(jobId: string): Promise<void> {
  await request<{ cancelled: boolean }>(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function deleteSourceAsset(assetId: string): Promise<void> {
  await request<{ deleted: boolean }>(
    `/api/source-assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" },
  );
}

export interface MomentCandidateRecord {
  id: string;
  startSeconds: number;
  endSeconds: number;
  score: number;
  acousticSalience: number;
  transcriptVelocity: number;
  narrativeArc: number;
  novelty: number;
  wordCount: number;
  markerCount: number;
  rationale: string;
}

export async function getJobMomentCandidates(jobId: string): Promise<MomentCandidateRecord[]> {
  const result = await request<{ candidates: MomentCandidateRecord[] }>(
    `/api/jobs/${encodeURIComponent(jobId)}/moments`,
  );
  return result.candidates ?? [];
}

export interface ClipRecord {
  id: string;
  jobId: string;
  title: string;
  description: string | null;
  hashtagsJson: string | null;
  durationSeconds: number;
  aspectRatio: "9:16";
  sizeBytes: number;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  sourceUrl: string;
  sourcePlatform: "youtube" | "twitch";
  title: string | null;
  status: "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";
  progress: number;
  stage: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface ClipMediaUrls {
  previewUrl: string;
  downloadUrl: string;
  expiresInSeconds: number;
}

export async function createClipMediaUrls(clipId: string): Promise<ClipMediaUrls> {
  return request<ClipMediaUrls>(
    "/api/clips/" + encodeURIComponent(clipId) + "/media-url",
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getClips(): Promise<ClipRecord[]> {
  const result = await request<{ clips: ClipRecord[] }>("/api/clips");
  return result.clips ?? [];
}

export async function getJobs(): Promise<JobRecord[]> {
  const result = await request<{ jobs: JobRecord[] }>("/api/jobs?limit=50");
  return result.jobs ?? [];
}

export function getClipPreviewUrl(clipId: string): string {
  return `${API_BASE}/api/clips/${encodeURIComponent(clipId)}/preview`;
}

export function getClipDownloadUrl(clipId: string): string {
  return `${API_BASE}/api/clips/${encodeURIComponent(clipId)}/download`;
}
