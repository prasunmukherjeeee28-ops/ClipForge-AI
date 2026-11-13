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

export interface JobStatusSnapshot {
  id: string;
  status: "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number;
  errorCode: string | null;
  sourceDurationSeconds: number | null;
  updatedAt: string;
}

export interface JobCandidate {
  id: string;
  startSeconds: number;
  endSeconds: number;
  title: string | null;
  transcriptExcerpt: string;
  score: number | null;
  category: string;
  rationale: string | null;
  reviewStatus: "pending" | "selected" | "rejected";
  signals: {
    acousticSalience: number;
    transcriptVelocity: number;
    narrativeArc: number;
    novelty: number;
  };
}

export async function getJobStatus(jobId: string): Promise<JobStatusSnapshot> {
  const result = await request<{ job: JobStatusSnapshot }>(
    `/api/jobs/${encodeURIComponent(jobId)}`,
  );
  return result.job;
}

export async function getJobCandidates(jobId: string): Promise<JobCandidate[]> {
  const result = await request<{
    candidates: Array<Omit<JobCandidate, "signals"> & { signalsJson: string }>;
  }>(`/api/jobs/${encodeURIComponent(jobId)}/candidates`);
  return (result.candidates ?? []).map((candidate) => {
    let signals: JobCandidate["signals"] = {
      acousticSalience: 0,
      transcriptVelocity: 0,
      narrativeArc: 0,
      novelty: 0,
    };
    try {
      const parsed = JSON.parse(candidate.signalsJson) as Partial<JobCandidate["signals"]>;
      signals = {
        acousticSalience: Number(parsed.acousticSalience) || 0,
        transcriptVelocity: Number(parsed.transcriptVelocity) || 0,
        narrativeArc: Number(parsed.narrativeArc) || 0,
        novelty: Number(parsed.novelty) || 0,
      };
    } catch {
      // Malformed optional signal metadata is displayed as zero, not trusted.
    }
    const { signalsJson: _signalsJson, ...rest } = candidate;
    return { ...rest, signals };
  });
}

export async function reviewJobCandidate(
  candidateId: string,
  reviewStatus: "selected" | "rejected" | "pending",
): Promise<void> {
  await request<{ candidate: { id: string; reviewStatus: string } }>(
    `/api/candidates/${encodeURIComponent(candidateId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ reviewStatus }),
    },
  );
}

export interface UserClip {
  id: string;
  jobId: string;
  candidateId: string | null;
  title: string;
  description: string | null;
  durationSeconds: number | null;
  aspectRatio: string;
  status: "queued" | "rendering" | "ready" | "failed" | "cancelled";
  progress: number;
  errorCode: string | null;
  outputSizeBytes: number | null;
  createdAt: string;
  completedAt: string | null;
}

export async function queueCandidateRender(
  candidateId: string,
  options: { captions: boolean; resolution: "1080x1920" | "720x1280" } = {
    captions: true,
    resolution: "1080x1920",
  },
): Promise<UserClip> {
  const result = await request<{ clip: UserClip }>(
    `/api/candidates/${encodeURIComponent(candidateId)}/render`,
    { method: "POST", body: JSON.stringify(options) },
  );
  return result.clip;
}

export async function getClips(): Promise<UserClip[]> {
  const result = await request<{ clips: UserClip[] }>("/api/clips");
  return result.clips ?? [];
}

export function getClipDownloadUrl(clipId: string): string {
  return `${API_BASE}/api/clips/${encodeURIComponent(clipId)}/download`;
}

export async function cancelClipRender(clipId: string): Promise<void> {
  await request<{ cancelled: boolean }>(
    `/api/clips/${encodeURIComponent(clipId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function retryClipRender(clipId: string): Promise<void> {
  await request<{ status: "queued" }>(
    `/api/clips/${encodeURIComponent(clipId)}/retry`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export interface UserJob {
  id: string;
  sourceUrl: string;
  sourcePlatform: "youtube" | "twitch";
  sourceType: "unknown" | "live" | "video";
  sourceDurationSeconds: number | null;
  mediaDurationSeconds: number | null;
  title: string | null;
  status: "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";
  progress: number;
  stage: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getJobs(): Promise<UserJob[]> {
  const result = await request<{ jobs: UserJob[] }>("/api/jobs");
  return result.jobs ?? [];
}

export interface CurrentUser {
  id: string;
  email: string;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const result = await request<{ user: CurrentUser }>("/api/me");
  return result.user;
}

export interface UserSourceAsset {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading" | "finalizing" | "ready" | "failed" | "deleting";
  createdAt: string;
  completedAt: string | null;
}

export async function getSourceAssets(): Promise<UserSourceAsset[]> {
  const result = await request<{ assets: UserSourceAsset[] }>("/api/source-assets");
  return result.assets ?? [];
}
