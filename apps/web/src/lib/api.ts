const API_BASE = (import.meta.env.VITE_CLIPFORGE_API_BASE_URL ?? "").replace(/\/+$/, "");

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
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body instanceof Blob ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  const payload = await response.json().catch(() => null) as
    | { error?: { message?: string } }
    | T
    | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error?.message
        : undefined;
    throw new Error(message || `ClipForge API request failed (${response.status}).`);
  }

  if (payload === null) throw new Error("The ClipForge API returned an empty response.");
  return payload as T;
}

export async function createSourceJob(
  sourceUrl: string,
  options: { captions: boolean; vertical: boolean; reviewScores: boolean },
): Promise<JobSubmission> {
  const result = await request<{ jobs: JobSubmission[] }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ urls: [sourceUrl], options }),
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
