import { Hono, type Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  PROCESSOR_SHARED_SECRET?: string;
};

type Variables = {
  user: { id: string; email: string; subject: string };
  processorBody: string;
  processorRawBody: Uint8Array;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();
const SOURCE_ASSET_PART_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SOURCE_ASSET_USER_BYTES = 8 * 1024 * 1024 * 1024;
const CLIP_OUTPUT_PART_BYTES = 8 * 1024 * 1024;
const MAX_CLIP_OUTPUT_BYTES = 512 * 1024 * 1024;
const SOURCE_ASSET_EXTENSIONS: Record<string, readonly string[]> = {
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
  "video/x-matroska": [".mkv"],
};

function expectedSourcePartSize(totalBytes: number, partNumber: number): number {
  const offset = (partNumber - 1) * SOURCE_ASSET_PART_BYTES;
  return Math.min(SOURCE_ASSET_PART_BYTES, totalBytes - offset);
}

function safeSourceFilename(value: unknown, contentType: string): string | null {
  if (typeof value !== "string") return null;
  const filename = value.normalize("NFKC")
    .replace(/[\/\\\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (!filename || filename.length > 200 || filename === "." || filename === "..") return null;
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return SOURCE_ASSET_EXTENSIONS[contentType]?.includes(extension) ? filename : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function verifyProcessorSignature(c: AppContext): Promise<boolean> {
  const secret = c.env.PROCESSOR_SHARED_SECRET;
  const timestamp = c.req.header("X-Processor-Timestamp") ?? "";
  const nonce = c.req.header("X-Processor-Nonce") ?? "";
  const signature = hexToBytes(c.req.header("X-Processor-Signature") ?? "");
  if (!secret || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{32}$/i.test(nonce) || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const canonicalPrefix = encoder.encode(
    [timestamp, nonce.toLowerCase(), c.req.method.toUpperCase(), new URL(c.req.url).pathname, ""].join("\n"),
  );
  const canonical = new Uint8Array(canonicalPrefix.length + rawBody.length);
  canonical.set(canonicalPrefix);
  canonical.set(rawBody, canonicalPrefix.length);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, canonical);
  if (!valid) return false;

  // Consume a one-time nonce only after signature verification. The primary key
  // makes concurrent replays deterministic; old nonces are pruned after expiry.
  await c.env.DB.prepare(
    "DELETE FROM processor_request_nonces WHERE created_at <= datetime('now', '-10 minutes')",
  ).run();
  const consumed = await c.env.DB.prepare(
    "INSERT INTO processor_request_nonces (nonce_hash) VALUES (?1) ON CONFLICT(nonce_hash) DO NOTHING",
  ).bind(await sha256Hex(nonce.toLowerCase())).run();
  if (!consumed.meta.changes) return false;

  const contentType = c.req.header("Content-Type") ?? "";
  c.set("processorBody", contentType.includes("application/json") ? new TextDecoder().decode(rawBody) : "");
  c.set("processorRawBody", rawBody);
  return true;
}

function parseProcessorBody<T>(c: AppContext): T | null {
  try { return JSON.parse(c.get("processorBody")) as T; } catch { return null; }
}

function jsonError(c: AppContext, message: string, status: 400 | 401 | 403 | 404 | 409 | 500 | 503) {
  return c.json({ error: { message } }, status);
}

function allowedEmails(env: Bindings): Set<string> {
  return new Set(
    env.ALLOWED_EMAILS.split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function sourcePlatform(value: string): "youtube" | "twitch" | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
  if (["twitch.tv", "www.twitch.tv", "m.twitch.tv", "clips.twitch.tv"].includes(host)) return "twitch";
  return null;
}

app.use("/internal/processor/*", async (c, next) => {
  if (!c.env.PROCESSOR_SHARED_SECRET || c.env.PROCESSOR_SHARED_SECRET.length < 32) return jsonError(c, "Processor authentication is not configured.", 503);
  if (!(await verifyProcessorSignature(c))) return jsonError(c, "Invalid processor signature.", 401);
  await next();
});

app.get("/health", (c) =>
  c.json({ status: "ok", service: "clipforge-api", timestamp: new Date().toISOString() }),
);

app.post("/internal/processor/ping", (c) =>
  c.json({ status: "ok", service: "clipforge-processor-gateway", timestamp: new Date().toISOString() }),
);

app.post("/internal/processor/claim", async (c) => {
  const body = parseProcessorBody<{ workerId?: unknown }>(c);
  if (!body || typeof body.workerId !== "string" || body.workerId.length < 1 || body.workerId.length > 100) {
    return jsonError(c, "A valid workerId is required.", 400);
  }

  // Recover abandoned leases before claiming new work.
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND cancel_requested = 1 AND lease_expires_at <= CURRENT_TIMESTAMP",
  ).run();
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'failed', stage = 'failed', error_code = 'retries_exhausted', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND lease_expires_at <= CURRENT_TIMESTAMP AND attempt_count >= max_attempts",
  ).run();
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'queued', stage = 'queued', error_code = 'lease_expired', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND lease_expires_at <= CURRENT_TIMESTAMP AND attempt_count < max_attempts AND cancel_requested = 0",
  ).run();

  const leaseId = uuid();
  const leaseToken = uuid() + uuid();
  const leaseTokenHash = await sha256Hex(leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET status = 'processing', stage = 'claimed', attempt_count = attempt_count + 1, lease_id = ?1, lease_token_hash = ?2, lease_expires_at = datetime('now', '+90 seconds'), last_heartbeat_at = CURRENT_TIMESTAMP, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND cancel_requested = 0 AND source_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready') ORDER BY created_at ASC LIMIT 1) AND status = 'queued' RETURNING id, user_id AS userId, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, source_asset_id AS sourceAssetId, options_json AS optionsJson, attempt_count AS attemptCount",
  ).bind(leaseId, leaseTokenHash).first<{
    id: string; userId: string; sourceUrl: string; sourcePlatform: string;
    sourceType: string; sourceAssetId: string; optionsJson: string; attemptCount: number;
  }>();

  if (!job) return c.json({ job: null });
  return c.json({ job, lease: { leaseId, leaseToken, expiresInSeconds: 90 } });
});

app.post("/internal/processor/heartbeat", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid heartbeat payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds'), last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing' AND lease_expires_at > CURRENT_TIMESTAMP RETURNING cancel_requested AS cancelRequested, lease_expires_at AS leaseExpiresAt",
  ).bind(body.jobId, body.leaseId, tokenHash).first<{ cancelRequested: number; leaseExpiresAt: string }>();
  if (!job) return jsonError(c, "Lease is no longer valid.", 409);
  return c.json({ ok: true, cancelRequested: job.cancelRequested === 1, leaseExpiresAt: job.leaseExpiresAt });
});

app.post("/internal/processor/progress", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string; stage?: string; progress?: number;
  }>(c);
  const progress = body?.progress;
  if (!body?.jobId || !body.leaseId || !body.leaseToken || typeof body.stage !== "string" ||
      body.stage.length < 1 || body.stage.length > 60 || typeof progress !== "number" ||
      !Number.isInteger(progress) || progress < 0 || progress > 99) {
    return jsonError(c, "Invalid progress payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET stage = ?1, progress = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3 AND lease_id = ?4 AND lease_token_hash = ?5 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(body.stage, progress, body.jobId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Lease is invalid or cancellation was requested.", 409);
  return c.json({ ok: true });
});

app.post("/internal/processor/source-metadata", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string; sourceId?: string; sourcePlatform?: string;
    sourceType?: string; title?: string; durationSeconds?: number | null; publishedAt?: string | null;
  }>(c);
  const duration = body?.durationSeconds;
  const publishedAt = body?.publishedAt;
  const sourceIdValid = body?.sourcePlatform === "youtube"
    ? typeof body.sourceId === "string" && /^[A-Za-z0-9_-]{11}$/.test(body.sourceId)
    : body?.sourcePlatform === "twitch"
      ? typeof body.sourceId === "string" && /^[0-9]{1,20}$/.test(body.sourceId)
      : false;
  if (
    !body?.jobId || !body.leaseId || !body.leaseToken ||
    !sourceIdValid ||
    (body.sourceType !== "video" && body.sourceType !== "live") ||
    typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200 ||
    (duration !== undefined && duration !== null &&
      (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 || duration > 604800)) ||
    (publishedAt !== undefined && publishedAt !== null &&
      (typeof publishedAt !== "string" || publishedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))))
  ) {
    return jsonError(c, "Invalid source metadata payload.", 400);
  }

  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET source_type = ?1, source_id = ?2, title = ?3, source_duration_seconds = ?4, source_published_at = ?5, source_verified_at = CURRENT_TIMESTAMP, stage = 'source_metadata_verified', progress = MAX(progress, 5), updated_at = CURRENT_TIMESTAMP WHERE id = ?6 AND lease_id = ?7 AND lease_token_hash = ?8 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND source_platform = ?9",
  ).bind(
    body.sourceType,
    body.sourceId,
    body.title.trim(),
    duration ?? null,
    publishedAt ?? null,
    body.jobId,
    body.leaseId,
    tokenHash,
    body.sourcePlatform,
  ).run();
  if (!result.meta.changes) return jsonError(c, "Lease is invalid, expired, or cancellation was requested.", 409);
  return c.json({ ok: true, sourceMetadataSaved: true });
});

app.post("/internal/processor/source-asset", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) {
    return jsonError(c, "Invalid source-asset request.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const asset = await c.env.DB.prepare(
    "SELECT source_assets.object_key AS objectKey, source_assets.filename AS filename, source_assets.content_type AS contentType, source_assets.size_bytes AS sizeBytes FROM jobs INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id WHERE jobs.id = ?1 AND jobs.lease_id = ?2 AND jobs.lease_token_hash = ?3 AND jobs.status = 'processing' AND jobs.cancel_requested = 0 AND jobs.lease_expires_at > CURRENT_TIMESTAMP AND source_assets.status = 'ready'",
  ).bind(body.jobId, body.leaseId, tokenHash).first<{
    objectKey: string; filename: string; contentType: string; sizeBytes: number;
  }>();
  if (!asset) return jsonError(c, "No ready source asset is attached to this active lease.", 409);

  const stored = await c.env.MEDIA.get(asset.objectKey);
  if (!stored) return jsonError(c, "The private source object is missing.", 409);
  if (stored.size !== asset.sizeBytes) {
    return jsonError(c, "Stored source size does not match its verified upload record.", 409);
  }

  // Stream the private R2 object directly; never buffer multi-gigabyte media in a Worker.
  return new Response(stored.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stored.size),
      "Cache-Control": "private, no-store",
      "X-ClipForge-Source-Content-Type": asset.contentType,
      "X-ClipForge-Source-Filename": encodeURIComponent(asset.filename),
    },
  });
});

app.post("/internal/processor/media-ready", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string;
    container?: string; videoCodec?: string; sourceAudioCodec?: string;
    width?: number; height?: number; durationSeconds?: number;
    audioCodec?: string; audioSampleRate?: number; audioChannels?: number; audioSizeBytes?: number;
  }>(c);
  const boundedName = (value: unknown, max: number) =>
    typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9,._+-]+$/.test(value);
  if (
    !body?.jobId || !body.leaseId || !body.leaseToken ||
    !boundedName(body.container, 100) ||
    !boundedName(body.videoCodec, 50) ||
    !boundedName(body.sourceAudioCodec, 50) ||
    !boundedName(body.audioCodec, 50) ||
    !Number.isInteger(body.width) || body.width! < 1 || body.width! > 7680 ||
    !Number.isInteger(body.height) || body.height! < 1 || body.height! > 4320 ||
    typeof body.durationSeconds !== "number" || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > 43200 ||
    body.audioCodec !== "pcm_s16le" || body.audioSampleRate !== 16000 || body.audioChannels !== 1 ||
    !Number.isSafeInteger(body.audioSizeBytes) || body.audioSizeBytes! < 1 || body.audioSizeBytes! > 1500000000
  ) {
    return jsonError(c, "Invalid media validation result.", 400);
  }

  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET media_container = ?1, media_video_codec = ?2, media_source_audio_codec = ?3, media_width = ?4, media_height = ?5, media_duration_seconds = ?6, audio_codec = ?7, audio_sample_rate = ?8, audio_channels = ?9, audio_size_bytes = ?10, media_verified_at = CURRENT_TIMESTAMP, status = 'review', stage = 'audio_extracted', progress = MAX(progress, 35), error_code = NULL, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?11 AND lease_id = ?12 AND lease_token_hash = ?13 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND source_type = 'video' AND source_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready') RETURNING status",
  ).bind(
    body.container, body.videoCodec, body.sourceAudioCodec, body.width, body.height,
    body.durationSeconds, body.audioCodec, body.audioSampleRate, body.audioChannels,
    body.audioSizeBytes, body.jobId, body.leaseId, tokenHash,
  ).first<{ status: "review" }>();
  if (!job) return jsonError(c, "Lease is invalid, expired, cancelled, or no ready owner-matched source asset is attached.", 409);
  return c.json({ ok: true, mediaReady: true, stage: "audio_extracted" });
});

app.post("/internal/processor/transcription-ready", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string;
    container?: string; videoCodec?: string; sourceAudioCodec?: string;
    width?: number; height?: number; durationSeconds?: number;
    audioCodec?: string; audioSampleRate?: number; audioChannels?: number; audioSizeBytes?: number;
    transcriptModel?: string; transcriptLanguage?: string | null;
    transcriptSegmentCount?: number; transcriptSizeBytes?: number; transcriptSha256?: string;
  }>(c);
  const boundedName = (value: unknown, max: number) =>
    typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9,._+-]+$/.test(value);
  const supportedModels = new Set(["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3"]);
  const validLanguage = body?.transcriptLanguage === null ||
    (typeof body?.transcriptLanguage === "string" &&
      /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(body.transcriptLanguage));
  if (
    !body?.jobId || !body.leaseId || !body.leaseToken ||
    !boundedName(body.container, 100) ||
    !boundedName(body.videoCodec, 50) ||
    !boundedName(body.sourceAudioCodec, 50) ||
    body.audioCodec !== "pcm_s16le" || body.audioSampleRate !== 16000 || body.audioChannels !== 1 ||
    !Number.isInteger(body.width) || body.width! < 1 || body.width! > 7680 ||
    !Number.isInteger(body.height) || body.height! < 1 || body.height! > 4320 ||
    typeof body.durationSeconds !== "number" || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > 43200 ||
    !Number.isSafeInteger(body.audioSizeBytes) || body.audioSizeBytes! < 44 || body.audioSizeBytes! > 1500000000 ||
    typeof body.transcriptModel !== "string" || !supportedModels.has(body.transcriptModel) ||
    !validLanguage ||
    !Number.isInteger(body.transcriptSegmentCount) || body.transcriptSegmentCount! < 0 || body.transcriptSegmentCount! > 500000 ||
    !Number.isSafeInteger(body.transcriptSizeBytes) || body.transcriptSizeBytes! < 2 || body.transcriptSizeBytes! > 100000000 ||
    typeof body.transcriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.transcriptSha256)
  ) {
    return jsonError(c, "Invalid media or transcript verification result.", 400);
  }

  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET media_container = ?1, media_video_codec = ?2, media_source_audio_codec = ?3, media_width = ?4, media_height = ?5, media_duration_seconds = ?6, audio_codec = ?7, audio_sample_rate = ?8, audio_channels = ?9, audio_size_bytes = ?10, media_verified_at = CURRENT_TIMESTAMP, transcript_model = ?11, transcript_language = ?12, transcript_segment_count = ?13, transcript_size_bytes = ?14, transcript_sha256 = ?15, transcript_verified_at = CURRENT_TIMESTAMP, status = 'processing', stage = 'transcribed', progress = MAX(progress, 60), error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?16 AND lease_id = ?17 AND lease_token_hash = ?18 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND source_type = 'video' AND source_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready') RETURNING status",
  ).bind(
    body.container, body.videoCodec, body.sourceAudioCodec, body.width, body.height,
    body.durationSeconds, body.audioCodec, body.audioSampleRate, body.audioChannels,
    body.audioSizeBytes, body.transcriptModel, body.transcriptLanguage, body.transcriptSegmentCount,
    body.transcriptSizeBytes, body.transcriptSha256, body.jobId, body.leaseId, tokenHash,
  ).first<{ status: "processing" }>();
  if (!job) return jsonError(c, "Lease is invalid, expired, cancelled, or no ready owner-matched source asset is attached.", 409);
  return c.json({ ok: true, mediaReady: true, transcriptionReady: true, stage: "transcribed" });
});

app.post("/internal/processor/moments-ready", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string; generationId?: string;
    candidates?: Array<{
      startSeconds?: number; endSeconds?: number; score?: number;
      rationale?: string; transcriptExcerpt?: string;
      signals?: {
        acousticSalience?: number; transcriptVelocity?: number;
        narrativeArc?: number; novelty?: number;
      };
    }>;
  }>(c);
  if (
    !body?.jobId || !body.leaseId || !body.leaseToken ||
    typeof body.generationId !== "string" || !/^[a-f0-9]{32}$/.test(body.generationId) ||
    !Array.isArray(body.candidates) || body.candidates.length > 50
  ) {
    return jsonError(c, "Invalid moment-analysis result.", 400);
  }

  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "SELECT media_duration_seconds AS durationSeconds FROM jobs WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND transcript_verified_at IS NOT NULL AND source_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready')",
  ).bind(body.jobId, body.leaseId, tokenHash).first<{ durationSeconds: number }>();
  if (!job || typeof job.durationSeconds !== "number") {
    return jsonError(c, "Lease is invalid or the transcript/source asset is not ready.", 409);
  }

  const validated = [];
  for (const candidate of body.candidates) {
    const signals = candidate?.signals;
    const signalValues = [
      signals?.acousticSalience, signals?.transcriptVelocity,
      signals?.narrativeArc, signals?.novelty,
    ];
    if (
      typeof candidate?.startSeconds !== "number" || !Number.isFinite(candidate.startSeconds) ||
      typeof candidate.endSeconds !== "number" || !Number.isFinite(candidate.endSeconds) ||
      candidate.startSeconds < 0 || candidate.endSeconds <= candidate.startSeconds ||
      candidate.endSeconds > job.durationSeconds ||
      typeof candidate.score !== "number" || !Number.isFinite(candidate.score) ||
      candidate.score < 0 || candidate.score > 1 ||
      typeof candidate.rationale !== "string" || candidate.rationale.length < 1 || candidate.rationale.length > 500 ||
      typeof candidate.transcriptExcerpt !== "string" || candidate.transcriptExcerpt.length > 1000 ||
      signalValues.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      return jsonError(c, "A candidate contains invalid timestamps, scores, signals, or transcript text.", 400);
    }
    validated.push({
      id: uuid(),
      start: candidate.startSeconds,
      end: candidate.endSeconds,
      score: candidate.score * 100,
      rationale: candidate.rationale,
      excerpt: candidate.transcriptExcerpt,
      signalsJson: JSON.stringify({
        acousticSalience: signals!.acousticSalience,
        transcriptVelocity: signals!.transcriptVelocity,
        narrativeArc: signals!.narrativeArc,
        novelty: signals!.novelty,
      }),
    });
  }

  const generationId = body.generationId;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "UPDATE jobs SET candidate_generation_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND transcript_verified_at IS NOT NULL",
    ).bind(generationId, body.jobId, body.leaseId, tokenHash),
    c.env.DB.prepare(
      "DELETE FROM candidates WHERE job_id = ?1 AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND candidate_generation_id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP)",
    ).bind(body.jobId, generationId, body.leaseId, tokenHash),
    ...validated.map((candidate) => c.env.DB.prepare(
      "INSERT INTO candidates (id, job_id, start_seconds, end_seconds, transcript_excerpt, score, generation_id, category, rationale, signals_json) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unknown', ?8, ?9 WHERE EXISTS (SELECT 1 FROM jobs INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id WHERE jobs.id = ?2 AND jobs.candidate_generation_id = ?7 AND jobs.lease_id = ?10 AND jobs.lease_token_hash = ?11 AND jobs.status = 'processing' AND jobs.cancel_requested = 0 AND jobs.lease_expires_at > CURRENT_TIMESTAMP AND jobs.transcript_verified_at IS NOT NULL AND source_assets.status = 'ready')",
    ).bind(
      candidate.id, body.jobId, candidate.start, candidate.end, candidate.excerpt,
      candidate.score, generationId, candidate.rationale, candidate.signalsJson,
      body.leaseId, tokenHash,
    )),
    c.env.DB.prepare(
      "UPDATE jobs SET status = 'review', stage = 'moments_detected', progress = MAX(progress, 75), candidate_generation_id = ?1, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND candidate_generation_id = ?1 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND transcript_verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready')",
    ).bind(generationId, body.jobId, body.leaseId, tokenHash),
  ];

  const results = await c.env.DB.batch(statements);
  const finalized = results[results.length - 1];
  if (!finalized?.meta?.changes) {
    return jsonError(c, "The processor lease expired or changed before candidates could be saved.", 409);
  }
  return c.json({ ok: true, stage: "moments_detected", candidateCount: validated.length, generationId });
});

app.post("/internal/processor/render-claim", async (c) => {
  const body = parseProcessorBody<{ workerId?: unknown }>(c);
  if (!body || typeof body.workerId !== "string" || body.workerId.length < 1 || body.workerId.length > 100) {
    return jsonError(c, "A valid workerId is required.", 400);
  }

  await c.env.DB.prepare(
    "UPDATE clips SET status = 'cancelled', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, upload_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'rendering' AND cancel_requested = 1 AND lease_expires_at <= CURRENT_TIMESTAMP",
  ).run();
  await c.env.DB.prepare(
    "UPDATE clips SET status = 'failed', error_code = 'render_retries_exhausted', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'rendering' AND lease_expires_at <= CURRENT_TIMESTAMP AND attempt_count >= max_attempts AND cancel_requested = 0",
  ).run();
  await c.env.DB.prepare(
    "UPDATE clips SET status = 'queued', progress = 0, error_code = 'render_lease_expired', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'rendering' AND lease_expires_at <= CURRENT_TIMESTAMP AND attempt_count < max_attempts AND cancel_requested = 0",
  ).run();

  const leaseId = uuid();
  const leaseToken = uuid() + uuid();
  const leaseTokenHash = await sha256Hex(leaseToken);
  const clip = await c.env.DB.prepare(
    "UPDATE clips SET status = 'rendering', attempt_count = attempt_count + 1, lease_id = ?1, lease_token_hash = ?2, lease_expires_at = datetime('now', '+90 seconds'), progress = MAX(progress, 1), updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT clips.id FROM clips INNER JOIN jobs ON jobs.id = clips.job_id AND jobs.user_id = clips.user_id INNER JOIN candidates ON candidates.id = clips.candidate_id AND candidates.job_id = clips.job_id INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id WHERE clips.status = 'queued' AND clips.cancel_requested = 0 AND candidates.review_status = 'selected' AND source_assets.status = 'ready' ORDER BY clips.created_at ASC LIMIT 1) AND status = 'queued' RETURNING id, job_id AS jobId, user_id AS userId, candidate_id AS candidateId, output_key AS outputKey, title, description, duration_seconds AS durationSeconds, render_options_json AS renderOptionsJson, lease_id AS leaseId",
  ).bind(leaseId, leaseTokenHash).first<{
    id: string; jobId: string; userId: string; candidateId: string;
    outputKey: string; title: string; description: string | null;
    durationSeconds: number; renderOptionsJson: string; leaseId: string;
  }>();
  if (!clip) return c.json({ clip: null });
  const candidate = await c.env.DB.prepare(
    "SELECT candidates.start_seconds AS startSeconds, candidates.end_seconds AS endSeconds, candidates.transcript_excerpt AS transcriptExcerpt, jobs.source_asset_id AS sourceAssetId FROM candidates INNER JOIN jobs ON jobs.id = candidates.job_id WHERE candidates.id = ?1 AND candidates.job_id = ?2 AND jobs.user_id = ?3",
  ).bind(clip.candidateId, clip.jobId, clip.userId).first<{
    startSeconds: number; endSeconds: number; transcriptExcerpt: string | null; sourceAssetId: string;
  }>();
  if (!candidate) {
    await c.env.DB.prepare(
      "UPDATE clips SET status = 'failed', error_code = 'render_source_unavailable', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ?1 AND lease_id = ?2",
    ).bind(clip.id, leaseId).run();
    return c.json({ clip: null });
  }
  return c.json({
    clip: { ...clip, ...candidate },
    lease: { leaseId, leaseToken, expiresInSeconds: 90 },
  });
});

app.post("/internal/processor/render-heartbeat", async (c) => {
  const body = parseProcessorBody<{ clipId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.clipId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid render heartbeat payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const clip = await c.env.DB.prepare(
    "UPDATE clips SET lease_expires_at = datetime('now', '+90 seconds'), updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'rendering' AND lease_expires_at > CURRENT_TIMESTAMP RETURNING cancel_requested AS cancelRequested, lease_expires_at AS leaseExpiresAt",
  ).bind(body.clipId, body.leaseId, tokenHash).first<{ cancelRequested: number; leaseExpiresAt: string }>();
  if (!clip) return jsonError(c, "Render lease is no longer valid.", 409);
  return c.json({ ok: true, cancelRequested: clip.cancelRequested === 1, leaseExpiresAt: clip.leaseExpiresAt });
});

app.post("/internal/processor/render-progress", async (c) => {
  const body = parseProcessorBody<{
    clipId?: string; leaseId?: string; leaseToken?: string; progress?: number;
  }>(c);
  if (
    !body?.clipId || !body.leaseId || !body.leaseToken ||
    typeof body.progress !== "number" || !Number.isInteger(body.progress) ||
    body.progress < 0 || body.progress > 99
  ) return jsonError(c, "Invalid render progress payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE clips SET progress = MAX(progress, ?1), updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(body.progress, body.clipId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Render lease is invalid or cancellation was requested.", 409);
  return c.json({ ok: true });
});

app.post("/internal/processor/render-source", async (c) => {
  const body = parseProcessorBody<{ clipId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.clipId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid render-source request.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const asset = await c.env.DB.prepare(
    "SELECT source_assets.object_key AS objectKey, source_assets.size_bytes AS sizeBytes, source_assets.content_type AS contentType FROM clips INNER JOIN jobs ON jobs.id = clips.job_id AND jobs.user_id = clips.user_id INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id WHERE clips.id = ?1 AND clips.lease_id = ?2 AND clips.lease_token_hash = ?3 AND clips.status = 'rendering' AND clips.cancel_requested = 0 AND clips.lease_expires_at > CURRENT_TIMESTAMP AND source_assets.status = 'ready'",
  ).bind(body.clipId, body.leaseId, tokenHash).first<{
    objectKey: string; sizeBytes: number; contentType: string;
  }>();
  if (!asset) return jsonError(c, "No owner-matched source asset is available for this render lease.", 409);
  const stored = await c.env.MEDIA.get(asset.objectKey);
  if (!stored || stored.size !== asset.sizeBytes) return jsonError(c, "The private source object is missing or has an invalid size.", 409);
  return new Response(stored.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stored.size),
      "Cache-Control": "private, no-store",
      "X-ClipForge-Source-Content-Type": asset.contentType,
    },
  });
});

app.post("/internal/processor/render-upload-init", async (c) => {
  const body = parseProcessorBody<{ clipId?: string; leaseId?: string; leaseToken?: string; sizeBytes?: number; sha256?: string }>(c);
  if (
    !body?.clipId || !body.leaseId || !body.leaseToken ||
    !Number.isSafeInteger(body.sizeBytes) || body.sizeBytes! < 1 || body.sizeBytes! > MAX_CLIP_OUTPUT_BYTES ||
    typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)
  ) return jsonError(c, "Invalid clip upload initialization payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const clip = await c.env.DB.prepare(
    "SELECT output_key AS outputKey, upload_id AS uploadId, upload_size_bytes AS uploadSizeBytes, output_sha256 AS outputSha256 FROM clips WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(body.clipId, body.leaseId, tokenHash).first<{
    outputKey: string; uploadId: string | null; uploadSizeBytes: number | null; outputSha256: string | null;
  }>();
  if (!clip) return jsonError(c, "Render lease is invalid or expired.", 409);
  if (clip.uploadId && clip.uploadSizeBytes === body.sizeBytes && clip.outputSha256 === body.sha256) {
    const uploaded = await c.env.DB.prepare(
      "SELECT part_number AS partNumber, size_bytes AS sizeBytes FROM clip_output_parts WHERE clip_id = ?1 AND status = 'uploaded' ORDER BY part_number",
    ).bind(body.clipId).all();
    return c.json({
      partSizeBytes: CLIP_OUTPUT_PART_BYTES,
      partCount: Math.ceil(body.sizeBytes! / CLIP_OUTPUT_PART_BYTES),
      uploadedParts: uploaded.results,
    });
  }

  if (clip.uploadId) {
    await c.env.MEDIA.resumeMultipartUpload(clip.outputKey, clip.uploadId).abort().catch(() => undefined);
    await c.env.DB.prepare("DELETE FROM clip_output_parts WHERE clip_id = ?1").bind(body.clipId).run();
  }
  const multipart = await c.env.MEDIA.createMultipartUpload(clip.outputKey, {
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: { clipId: body.clipId, sha256: body.sha256 },
  });
  const updated = await c.env.DB.prepare(
    "UPDATE clips SET upload_id = ?1, upload_size_bytes = ?2, output_sha256 = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4 AND lease_id = ?5 AND lease_token_hash = ?6 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(multipart.uploadId, body.sizeBytes, body.sha256, body.clipId, body.leaseId, tokenHash).run();
  if (!updated.meta.changes) {
    await multipart.abort().catch(() => undefined);
    return jsonError(c, "Render lease changed while initializing the output upload.", 409);
  }
  return c.json({
    partSizeBytes: CLIP_OUTPUT_PART_BYTES,
    partCount: Math.ceil(body.sizeBytes! / CLIP_OUTPUT_PART_BYTES),
    uploadedParts: [],
  });
});

app.post("/internal/processor/render-upload-part/:clipId/:partNumber", async (c) => {
  const clipId = c.req.param("clipId");
  const partNumber = Number(c.req.param("partNumber"));
  const packet = c.get("processorRawBody");
  if (packet.byteLength < 5 || packet.byteLength > CLIP_OUTPUT_PART_BYTES + 4096) {
    return jsonError(c, "Invalid render output packet size.", 400);
  }
  const metadataLength = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0);
  if (metadataLength < 2 || metadataLength > 2048 || metadataLength + 4 >= packet.byteLength) {
    return jsonError(c, "Invalid render output packet metadata.", 400);
  }
  let metadata: { clipId?: string; leaseId?: string; leaseToken?: string };
  try {
    metadata = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + metadataLength)));
  } catch {
    return jsonError(c, "Invalid render output packet metadata.", 400);
  }
  const rawBody = packet.subarray(4 + metadataLength);
  if (
    metadata.clipId !== clipId || typeof metadata.leaseId !== "string" ||
    typeof metadata.leaseToken !== "string" ||
    !Number.isSafeInteger(partNumber) || partNumber < 1 ||
    rawBody.byteLength < 1 || rawBody.byteLength > CLIP_OUTPUT_PART_BYTES
  ) return jsonError(c, "Invalid render output part.", 400);
  const contentLength = Number(c.req.header("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== packet.byteLength) {
    return jsonError(c, "Render output packet has an invalid Content-Length.", 400);
  }
  const tokenHash = await sha256Hex(metadata.leaseToken);
  const clip = await c.env.DB.prepare(
    "SELECT output_key AS outputKey, upload_id AS uploadId, upload_size_bytes AS uploadSizeBytes, output_sha256 AS outputSha256 FROM clips WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND upload_id IS NOT NULL",
  ).bind(clipId, metadata.leaseId, tokenHash).first<{
    outputKey: string; uploadId: string; uploadSizeBytes: number;
  }>();
  if (!clip) return jsonError(c, "Render upload lease is invalid.", 409);
  const partCount = Math.ceil(clip.uploadSizeBytes / CLIP_OUTPUT_PART_BYTES);
  if (partNumber > partCount) return jsonError(c, "Render part number is outside the expected range.", 400);
  const expectedBytes = Math.min(CLIP_OUTPUT_PART_BYTES, clip.uploadSizeBytes - (partNumber - 1) * CLIP_OUTPUT_PART_BYTES);
  if (rawBody.byteLength !== expectedBytes) return jsonError(c, "Render output part size does not match the upload session.", 400);

  const existing = await c.env.DB.prepare(
    "SELECT status, size_bytes AS sizeBytes FROM clip_output_parts WHERE clip_id = ?1 AND part_number = ?2",
  ).bind(clipId, partNumber).first<{ status: string; sizeBytes: number }>();
  if (existing?.status === "uploaded" && existing.sizeBytes === expectedBytes) {
    return c.json({ clipId, partNumber, uploaded: true, alreadyUploaded: true });
  }
  if (existing?.status === "uploading") return jsonError(c, "This output part is already being stored.", 409);

  const reservation = await c.env.DB.prepare(
    "INSERT INTO clip_output_parts (clip_id, part_number, status, size_bytes) SELECT ?1, ?2, 'uploading', ?3 WHERE EXISTS (SELECT 1 FROM clips WHERE id = ?1 AND lease_id = ?4 AND lease_token_hash = ?5 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP) ON CONFLICT(clip_id, part_number) DO NOTHING",
  ).bind(clipId, partNumber, expectedBytes, metadata.leaseId, tokenHash).run();
  if (!reservation.meta.changes) return jsonError(c, "This output part is already being stored.", 409);

  try {
    const uploaded = await c.env.MEDIA.resumeMultipartUpload(clip.outputKey, clip.uploadId)
      .uploadPart(partNumber, rawBody);
    const saved = await c.env.DB.prepare(
      "UPDATE clip_output_parts SET status = 'uploaded', etag = ?1, updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?2 AND part_number = ?3 AND status = 'uploading'",
    ).bind(uploaded.etag, clipId, partNumber).run();
    if (!saved.meta.changes) return jsonError(c, "Output part state changed; inspect the clip upload and retry.", 409);
  } catch {
    await c.env.DB.prepare(
      "DELETE FROM clip_output_parts WHERE clip_id = ?1 AND part_number = ?2 AND status = 'uploading'",
    ).bind(clipId, partNumber).run();
    return jsonError(c, "This output part could not be stored. Retry the missing part.", 409);
  }
  return c.json({ clipId, partNumber, uploaded: true }, 201);
});

app.post("/internal/processor/render-complete", async (c) => {
  const body = parseProcessorBody<{ clipId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.clipId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid render completion payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const clip = await c.env.DB.prepare(
    "SELECT output_key AS outputKey, upload_id AS uploadId, upload_size_bytes AS uploadSizeBytes FROM clips WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP AND upload_id IS NOT NULL",
  ).bind(body.clipId, body.leaseId, tokenHash).first<{
    outputKey: string; uploadId: string; uploadSizeBytes: number; outputSha256: string;
  }>();
  if (!clip) return jsonError(c, "Render lease is invalid or expired.", 409);

  const expectedCount = Math.ceil(clip.uploadSizeBytes / CLIP_OUTPUT_PART_BYTES);
  const parts = await c.env.DB.prepare(
    "SELECT part_number AS partNumber, etag, size_bytes AS sizeBytes FROM clip_output_parts WHERE clip_id = ?1 AND status = 'uploaded' ORDER BY part_number",
  ).bind(body.clipId).all<{ partNumber: number; etag: string; sizeBytes: number }>();
  if (parts.results.length !== expectedCount) return jsonError(c, "Some rendered MP4 parts are missing.", 409);
  for (let i = 0; i < parts.results.length; i++) {
    const part = parts.results[i];
    const expectedBytes = Math.min(CLIP_OUTPUT_PART_BYTES, clip.uploadSizeBytes - i * CLIP_OUTPUT_PART_BYTES);
    if (part.partNumber !== i + 1 || part.sizeBytes !== expectedBytes || !part.etag) {
      return jsonError(c, "Rendered MP4 parts do not match the expected output size.", 409);
    }
  }

  let stored: R2Object;
  try {
    stored = await c.env.MEDIA.resumeMultipartUpload(clip.outputKey, clip.uploadId)
      .complete(parts.results.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
  } catch {
    const existingObject = await c.env.MEDIA.head(clip.outputKey);
    if (!existingObject) return jsonError(c, "R2 could not finalize the rendered MP4. Retry completion.", 409);
    stored = existingObject;
  }
  if (
    stored.size !== clip.uploadSizeBytes ||
    !clip.outputSha256 ||
    stored.customMetadata?.sha256 !== clip.outputSha256
  ) {
    await c.env.MEDIA.delete(clip.outputKey);
    return jsonError(c, "Stored MP4 size or output digest did not match the verified render.", 409);
  }
  const finished = await c.env.DB.prepare(
    "UPDATE clips SET status = 'ready', progress = 100, output_size_bytes = ?1, upload_id = NULL, completed_at = CURRENT_TIMESTAMP, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'rendering' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(stored.size, body.clipId, body.leaseId, tokenHash).run();
  if (!finished.meta.changes) return jsonError(c, "Render lease expired before output registration.", 409);
  return c.json({ clipId: body.clipId, status: "ready", sizeBytes: stored.size });
});

app.post("/internal/processor/render-fail", async (c) => {
  const body = parseProcessorBody<{ clipId?: string; leaseId?: string; leaseToken?: string; errorCode?: string }>(c);
  if (!body?.clipId || !body.leaseId || !body.leaseToken ||
      typeof body.errorCode !== "string" || !/^[a-z0-9_]{1,60}$/.test(body.errorCode)) {
    return jsonError(c, "Invalid render failure payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE clips SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'failed' END, error_code = CASE WHEN cancel_requested = 1 THEN error_code ELSE ?1 END, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'rendering' AND lease_expires_at > CURRENT_TIMESTAMP RETURNING status",
  ).bind(body.errorCode, body.clipId, body.leaseId, tokenHash).first<{ status: "failed" | "cancelled" }>();
  if (!result) return jsonError(c, "Render lease is no longer valid.", 409);
  return c.json({ ok: true, status: result.status });
});

app.post("/internal/processor/source-ready", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) {
    return jsonError(c, "Invalid source-ready payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'review' END, stage = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'source_ready' END, progress = CASE WHEN cancel_requested = 1 THEN progress ELSE MAX(progress, 20) END, error_code = NULL, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing' AND lease_expires_at > CURRENT_TIMESTAMP AND source_type = 'video' AND source_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM source_assets WHERE source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready') RETURNING status",
  ).bind(body.jobId, body.leaseId, tokenHash).first<{ status: "review" | "cancelled" }>();
  if (!job) return jsonError(c, "Lease is invalid, expired, or no ready source asset is attached.", 409);
  return c.json({ ok: true, sourceReady: job.status === "review", cancelled: job.status === "cancelled" });
});

app.post("/internal/processor/release", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid release payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END, stage = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END, progress = CASE WHEN cancel_requested = 1 THEN progress ELSE 0 END, attempt_count = CASE WHEN cancel_requested = 1 THEN attempt_count ELSE MAX(0, attempt_count - 1) END, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, error_code = CASE WHEN cancel_requested = 1 THEN error_code ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing' AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(body.jobId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Lease is no longer valid.", 409);
  return c.json({ ok: true, released: true });
});

app.post("/internal/processor/fail", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string; errorCode?: string;
  }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken ||
      typeof body.errorCode !== "string" || !/^[a-z0-9_]{1,60}$/.test(body.errorCode)) {
    return jsonError(c, "Invalid failure payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'failed' END, stage = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'failed' END, error_code = CASE WHEN cancel_requested = 1 THEN error_code ELSE ?1 END, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'processing' AND lease_expires_at > CURRENT_TIMESTAMP RETURNING status",
  ).bind(body.errorCode, body.jobId, body.leaseId, tokenHash).first<{ status: "failed" | "cancelled" }>();
  if (!job) return jsonError(c, "Lease is no longer valid.", 409);
  return c.json({ ok: true, failed: job.status === "failed", cancelled: job.status === "cancelled" });
});

app.post("/internal/processor/complete", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string; title?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken ||
      (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > 200))) {
    return jsonError(c, "Invalid completion payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status = 'completed', stage = 'completed', progress = 100, title = COALESCE(?1, title), completed_at = CURRENT_TIMESTAMP, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND lease_id = ?3 AND lease_token_hash = ?4 AND status = 'processing' AND cancel_requested = 0 AND lease_expires_at > CURRENT_TIMESTAMP",
  ).bind(body.title?.trim() || null, body.jobId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Lease is invalid, expired, or cancellation was requested.", 409);
  return c.json({ ok: true, completed: true });
});

app.use("/api/*", async (c, next) => {
  const domain = c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = c.env.ACCESS_AUD;
  const emails = allowedEmails(c.env);

  if (!domain || domain.startsWith("YOUR_") || !audience || audience.startsWith("SET_")) {
    return jsonError(c, "Authentication is not configured.", 503);
  }
  if (emails.size !== 2) {
    return jsonError(c, "Configure exactly two allowed account emails.", 503);
  }

  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion) return jsonError(c, "Authentication required.", 401);

  try {
    const issuer = `https://${domain}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience });
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";

    if (!subject || !email || !emails.has(email)) {
      return jsonError(c, "This account is not authorized to use ClipForge.", 403);
    }

    const emailOwner = await c.env.DB.prepare(
      "SELECT auth_subject AS authSubject FROM users WHERE email = ?1 LIMIT 1",
    ).bind(email).first<{ authSubject: string }>();
    if (emailOwner && emailOwner.authSubject !== subject) {
      return jsonError(c, "This email is already linked to another ClipForge account.", 403);
    }

    const existing = await c.env.DB.prepare(
      "SELECT id, email FROM users WHERE auth_subject = ?1 LIMIT 1",
    )
      .bind(subject)
      .first<{ id: string; email: string }>();

    let userId = existing?.id;
    if (!userId) {
      const proposedId = uuid();
      await c.env.DB.prepare(
        "INSERT INTO users (id, auth_subject, email, display_name) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(auth_subject) DO NOTHING",
      )
        .bind(
          proposedId,
          subject,
          email,
          typeof payload.name === "string" ? payload.name.slice(0, 100) : null,
        )
        .run();
      const inserted = await c.env.DB.prepare(
        "SELECT id FROM users WHERE auth_subject = ?1 LIMIT 1",
      )
        .bind(subject)
        .first<{ id: string }>();
      if (!inserted) return jsonError(c, "Could not initialize account.", 500);
      userId = inserted.id;
    } else if (existing && existing.email !== email) {
      await c.env.DB.prepare(
        "UPDATE users SET email = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
      )
        .bind(email, userId)
        .run();
    }

    c.set("user", { id: userId, email, subject });
    await next();
  } catch {
    return jsonError(c, "Invalid or expired authentication token.", 401);
  }
});

app.get("/api/me", (c) =>
  c.json({ user: { id: c.get("user").id, email: c.get("user").email } }),
);

app.post("/api/source-assets", async (c) => {
  const body = await c.req.json<{ filename?: unknown; contentType?: unknown; sizeBytes?: unknown }>().catch(() => null);
  const contentType = typeof body?.contentType === "string" ? body.contentType : "";
  const filename = safeSourceFilename(body?.filename, contentType);
  const sizeBytes = body?.sizeBytes;
  if (
    !filename || !Object.hasOwn(SOURCE_ASSET_EXTENSIONS, contentType) ||
    typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 || sizeBytes > MAX_SOURCE_ASSET_BYTES
  ) {
    return jsonError(c, "Provide a supported video file name, MIME type, and size (maximum 2 GiB).", 400);
  }

  const user = c.get("user");
  const assetId = uuid();
  const objectKey = `source-assets/${user.id}/${assetId}/source`;
  let multipart: R2MultipartUpload;
  try {
    multipart = await c.env.MEDIA.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
      customMetadata: { assetId, userId: user.id },
    });
  } catch {
    return jsonError(c, "Private source storage is temporarily unavailable.", 503);
  }

  try {
    const inserted = await c.env.DB.prepare(
      "INSERT INTO source_assets (id, user_id, object_key, filename, content_type, size_bytes, upload_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE COALESCE((SELECT SUM(size_bytes) FROM source_assets WHERE user_id = ?2 AND status IN ('uploading','finalizing','ready','deleting')), 0) + ?6 <= ?8",
    ).bind(
      assetId, user.id, objectKey, filename, contentType, sizeBytes, multipart.uploadId, MAX_SOURCE_ASSET_USER_BYTES,
    ).run();
    if (!inserted.meta.changes) {
      await multipart.abort().catch(() => undefined);
      return jsonError(c, "Your private source storage quota would be exceeded.", 409);
    }
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }

  return c.json({
    asset: {
      id: assetId,
      filename,
      contentType,
      sizeBytes,
      status: "uploading",
      partSizeBytes: SOURCE_ASSET_PART_BYTES,
      partCount: Math.ceil(sizeBytes / SOURCE_ASSET_PART_BYTES),
    },
  }, 201);
});

app.get("/api/source-assets", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, filename, content_type AS contentType, size_bytes AS sizeBytes, status, created_at AS createdAt, completed_at AS completedAt FROM source_assets WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100",
  ).bind(c.get("user").id).all();
  return c.json({ assets: result.results });
});

app.get("/api/source-assets/:assetId", async (c) => {
  const asset = await c.env.DB.prepare(
    "SELECT id, filename, content_type AS contentType, size_bytes AS sizeBytes, status, created_at AS createdAt, completed_at AS completedAt FROM source_assets WHERE id = ?1 AND user_id = ?2",
  ).bind(c.req.param("assetId"), c.get("user").id).first();
  if (!asset) return jsonError(c, "Source asset not found.", 404);
  const parts = await c.env.DB.prepare(
    "SELECT part_number AS partNumber, size_bytes AS sizeBytes FROM source_asset_parts WHERE asset_id = ?1 AND status = 'uploaded' ORDER BY part_number",
  ).bind(c.req.param("assetId")).all();
  return c.json({ asset, uploadedParts: parts.results });
});

app.put("/api/source-assets/:assetId/parts/:partNumber", async (c) => {
  const assetId = c.req.param("assetId");
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
    return jsonError(c, "Invalid multipart part number.", 400);
  }

  const asset = await c.env.DB.prepare(
    "SELECT object_key AS objectKey, upload_id AS uploadId, size_bytes AS sizeBytes FROM source_assets WHERE id = ?1 AND user_id = ?2 AND status = 'uploading'",
  ).bind(assetId, c.get("user").id).first<{ objectKey: string; uploadId: string; sizeBytes: number }>();
  if (!asset) return jsonError(c, "Active source upload not found.", 404);

  const partCount = Math.ceil(asset.sizeBytes / SOURCE_ASSET_PART_BYTES);
  if (partNumber > partCount) return jsonError(c, "Part number exceeds the expected upload size.", 400);
  const expectedBytes = expectedSourcePartSize(asset.sizeBytes, partNumber);
  const contentLength = Number(c.req.header("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes || !c.req.raw.body) {
    return jsonError(c, "Upload part has an invalid or missing Content-Length.", 400);
  }

  await c.env.DB.prepare(
    "DELETE FROM source_asset_parts WHERE asset_id = ?1 AND part_number = ?2 AND status = 'uploading' AND updated_at <= datetime('now', '-15 minutes')",
  ).bind(assetId, partNumber).run();
  const reservation = await c.env.DB.prepare(
    "INSERT INTO source_asset_parts (asset_id, part_number, status, size_bytes) SELECT ?1, ?2, 'uploading', ?3 WHERE EXISTS (SELECT 1 FROM source_assets WHERE id = ?1 AND user_id = ?4 AND status = 'uploading') ON CONFLICT(asset_id, part_number) DO NOTHING",
  ).bind(assetId, partNumber, expectedBytes, c.get("user").id).run();
  if (!reservation.meta.changes) {
    return jsonError(c, "This part is already uploaded or currently being stored. Check upload status before retrying.", 409);
  }

  try {
    const uploaded = await c.env.MEDIA.resumeMultipartUpload(asset.objectKey, asset.uploadId)
      .uploadPart(partNumber, c.req.raw.body);
    const saved = await c.env.DB.prepare(
      "UPDATE source_asset_parts SET status = 'uploaded', etag = ?1, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?2 AND part_number = ?3 AND status = 'uploading'",
    ).bind(uploaded.etag, assetId, partNumber).run();
    if (!saved.meta.changes) return jsonError(c, "Upload part state changed; inspect the asset and retry any missing part.", 409);
  } catch {
    await c.env.DB.prepare(
      "DELETE FROM source_asset_parts WHERE asset_id = ?1 AND part_number = ?2 AND status = 'uploading'",
    ).bind(assetId, partNumber).run();
    return jsonError(c, "This upload part could not be stored. Retry the missing part.", 409);
  }

  return c.json({ assetId, partNumber, uploaded: true }, 201);
});

app.post("/api/source-assets/:assetId/complete", async (c) => {
  const assetId = c.req.param("assetId");
  const asset = await c.env.DB.prepare(
    "SELECT object_key AS objectKey, upload_id AS uploadId, size_bytes AS sizeBytes, status FROM source_assets WHERE id = ?1 AND user_id = ?2 AND status IN ('uploading','finalizing')",
  ).bind(assetId, c.get("user").id).first<{ objectKey: string; uploadId: string; sizeBytes: number; status: "uploading" | "finalizing" }>();
  if (!asset) return jsonError(c, "Active source upload not found.", 404);

  if (asset.status === "finalizing") {
    // Recover a request that completed R2 but failed before it could update D1.
    const existingObject = await c.env.MEDIA.head(asset.objectKey);
    if (existingObject) {
      if (existingObject.size !== asset.sizeBytes) {
        await c.env.MEDIA.delete(asset.objectKey);
        await c.env.DB.prepare(
          "UPDATE source_assets SET status = 'failed', upload_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing'",
        ).bind(assetId, c.get("user").id).run();
        return jsonError(c, "Stored file size did not match the declared size; upload rejected.", 409);
      }
      const recovered = await c.env.DB.prepare(
        "UPDATE source_assets SET status = 'ready', upload_id = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing' AND upload_id = ?3",
      ).bind(assetId, c.get("user").id, asset.uploadId).run();
      if (!recovered.meta.changes) return jsonError(c, "Upload state changed while recovering finalization.", 409);
      return c.json({ assetId, status: "ready", sizeBytes: existingObject.size });
    }

    await c.env.DB.prepare(
      "UPDATE source_assets SET status = 'uploading', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing' AND upload_id = ?3",
    ).bind(assetId, c.get("user").id, asset.uploadId).run();
  }

  const expectedCount = Math.ceil(asset.sizeBytes / SOURCE_ASSET_PART_BYTES);
  const parts = await c.env.DB.prepare(
    "SELECT part_number AS partNumber, etag, size_bytes AS sizeBytes FROM source_asset_parts WHERE asset_id = ?1 AND status = 'uploaded' ORDER BY part_number",
  ).bind(assetId).all<{ partNumber: number; etag: string; sizeBytes: number }>();
  if (parts.results.length !== expectedCount) {
    return jsonError(c, "Some upload parts are missing. Upload all listed parts before completing.", 409);
  }
  for (let index = 0; index < parts.results.length; index++) {
    const part = parts.results[index];
    if (part.partNumber !== index + 1 ||
        part.sizeBytes !== expectedSourcePartSize(asset.sizeBytes, index + 1) ||
        !part.etag) {
      return jsonError(c, "Uploaded parts do not match the declared file size.", 409);
    }
  }

  const finalizing = await c.env.DB.prepare(
    "UPDATE source_assets SET status = 'finalizing', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'uploading' AND upload_id = ?3 AND NOT EXISTS (SELECT 1 FROM source_asset_parts WHERE asset_id = ?1 AND status = 'uploading')",
  ).bind(assetId, c.get("user").id, asset.uploadId).run();
  if (!finalizing.meta.changes) {
    return jsonError(c, "An upload part is still in progress or this asset is no longer finalizable.", 409);
  }

  let storedObject: R2Object;
  try {
    storedObject = await c.env.MEDIA.resumeMultipartUpload(asset.objectKey, asset.uploadId)
      .complete(parts.results.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
  } catch {
    // A network failure can happen after R2 finalized the object. Detect that
    // case before reopening the multipart upload for a safe client retry.
    const existingObject = await c.env.MEDIA.head(asset.objectKey);
    if (existingObject) {
      storedObject = existingObject;
    } else {
      await c.env.DB.prepare(
        "UPDATE source_assets SET status = 'uploading', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing' AND upload_id = ?3",
      ).bind(assetId, c.get("user").id, asset.uploadId).run();
      return jsonError(c, "R2 could not finalize this upload. Check its parts and retry.", 409);
    }
  }
  if (storedObject.size !== asset.sizeBytes) {
    await c.env.MEDIA.delete(asset.objectKey);
    await c.env.DB.prepare(
      "UPDATE source_assets SET status = 'failed', upload_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing'",
    ).bind(assetId, c.get("user").id).run();
    return jsonError(c, "Stored file size did not match the declared size; upload rejected.", 409);
  }

  const completed = await c.env.DB.prepare(
    "UPDATE source_assets SET status = 'ready', upload_id = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'finalizing' AND upload_id = ?3",
  ).bind(assetId, c.get("user").id, asset.uploadId).run();
  if (!completed.meta.changes) return jsonError(c, "Upload state changed while finalizing. Refresh the asset status.", 409);
  return c.json({ assetId, status: "ready", sizeBytes: storedObject.size });
});

app.delete("/api/source-assets/:assetId", async (c) => {
  const assetId = c.req.param("assetId");
  const userId = c.get("user").id;
  // Reserve deletion atomically before touching R2. Attachment and upload
  // completion both require their own source_assets state predicates, so this
  // closes the race where a job could attach an object while it was deleted.
  const asset = await c.env.DB.prepare(
    "UPDATE source_assets SET status = 'deleting', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status IN ('uploading','ready','failed','deleting') AND NOT EXISTS (SELECT 1 FROM jobs WHERE source_asset_id = ?1 AND status NOT IN ('failed','cancelled','completed')) AND NOT EXISTS (SELECT 1 FROM source_asset_parts WHERE asset_id = ?1 AND status = 'uploading') RETURNING object_key AS objectKey, upload_id AS uploadId",
  ).bind(assetId, userId).first<{ objectKey: string; uploadId: string | null }>();
  if (!asset) {
    const exists = await c.env.DB.prepare(
      "SELECT id FROM source_assets WHERE id = ?1 AND user_id = ?2",
    ).bind(assetId, userId).first();
    if (!exists) return jsonError(c, "Source asset not found.", 404);
    return jsonError(c, "This source asset is attached to an active job or has an upload part/finalization in progress.", 409);
  }

  try {
    if (asset.uploadId) {
      try {
        await c.env.MEDIA.resumeMultipartUpload(asset.objectKey, asset.uploadId).abort();
      } catch {
        // If an earlier retry already aborted it, no completed object exists.
        const existingObject = await c.env.MEDIA.head(asset.objectKey);
        if (existingObject) throw new Error("Multipart upload cleanup is incomplete.");
      }
    } else {
      // R2 delete is safe to repeat if a previous cleanup succeeded but the
      // D1 row deletion failed.
      await c.env.MEDIA.delete(asset.objectKey);
    }
  } catch {
    return jsonError(c, "Source storage could not be cleaned up. Retry deletion later.", 409);
  }
  const removed = await c.env.DB.prepare(
    "DELETE FROM source_assets WHERE id = ?1 AND user_id = ?2 AND status = 'deleting'",
  ).bind(assetId, userId).run();
  if (!removed.meta.changes) return jsonError(c, "Source asset cleanup is pending. Retry deletion later.", 409);
  return c.json({ assetId, deleted: true });
});

app.post("/api/jobs", async (c) => {
  const body = await c.req.json<{ urls?: unknown; options?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 20) {
    return jsonError(c, "Provide between 1 and 20 video or stream URLs.", 400);
  }

  const urls = body.urls.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (urls.some((url) => !url || url.length > 2048) || new Set(urls).size !== urls.length) {
    return jsonError(c, "Every URL must be a unique, non-empty string.", 400);
  }

  const parsed = urls.map((url) => ({ url, platform: sourcePlatform(url) }));
  if (parsed.some((item) => item.platform === null)) {
    return jsonError(c, "Only supported HTTPS YouTube and Twitch URLs are accepted.", 400);
  }

  const options =
    body.options && typeof body.options === "object" && !Array.isArray(body.options)
      ? (body.options as Record<string, unknown>)
      : {};
  const safeOptions = {
    captions: options.captions !== false,
    vertical: options.vertical !== false,
    reviewScores: options.reviewScores !== false,
    instruction: typeof options.instruction === "string" ? options.instruction.slice(0, 500) : "",
  };

  const user = c.get("user");
  const created: Array<{ id: string; status: "review"; stage: "awaiting_source_asset"; sourcePlatform: string }> = [];
  const inserts = parsed.map((item) => {
    const id = uuid();
    const platform = item.platform as "youtube" | "twitch";
    created.push({ id, status: "review", stage: "awaiting_source_asset", sourcePlatform: platform });
    return c.env.DB.prepare(
      "INSERT INTO jobs (id, user_id, source_url, source_platform, options_json, status, stage) VALUES (?1, ?2, ?3, ?4, ?5, 'review', 'awaiting_source_asset')",
    ).bind(id, user.id, item.url, platform, JSON.stringify(safeOptions));
  });

  // D1 batch is transactional: a bulk submission is all-or-nothing.
  await c.env.DB.batch(inserts);
  return c.json({ jobs: created }, 202);
});

app.post("/api/jobs/:jobId/source-asset", async (c) => {
  const body = await c.req.json<{ sourceAssetId?: unknown }>().catch(() => null);
  if (typeof body?.sourceAssetId !== "string" || !body.sourceAssetId.trim()) {
    return jsonError(c, "A sourceAssetId is required.", 400);
  }
  const user = c.get("user");
  const jobId = c.req.param("jobId");
  const exists = await c.env.DB.prepare(
    "SELECT id, status, stage FROM jobs WHERE id = ?1 AND user_id = ?2",
  ).bind(jobId, user.id).first<{ id: string; status: string; stage: string }>();
  if (!exists) return jsonError(c, "Job not found.", 404);
  if (exists.status !== "review" || exists.stage !== "awaiting_source_asset") {
    return jsonError(c, "This job is not waiting for a source file.", 409);
  }

  const attached = await c.env.DB.prepare(
    "UPDATE jobs SET source_asset_id = ?1, status = 'queued', stage = 'queued', progress = 0, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND user_id = ?3 AND status = 'review' AND stage = 'awaiting_source_asset' AND EXISTS (SELECT 1 FROM source_assets WHERE id = ?1 AND user_id = ?3 AND status = 'ready') AND NOT EXISTS (SELECT 1 FROM jobs WHERE source_asset_id = ?1)",
  ).bind(body.sourceAssetId, jobId, user.id).run();
  if (!attached.meta.changes) {
    return jsonError(c, "The source file is not ready, belongs to another account, or is already attached to a job.", 409);
  }
  return c.json({ jobId, sourceAssetId: body.sourceAssetId, status: "queued" }, 202);
});

app.get("/api/jobs", async (c) => {
  const user = c.get("user");
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 50, 1), 100);
  const result = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, source_id AS sourceId, source_duration_seconds AS sourceDurationSeconds, source_published_at AS sourcePublishedAt, source_verified_at AS sourceVerifiedAt, source_asset_id AS sourceAssetId, media_container AS mediaContainer, media_video_codec AS mediaVideoCodec, media_source_audio_codec AS mediaSourceAudioCodec, media_width AS mediaWidth, media_height AS mediaHeight, media_duration_seconds AS mediaDurationSeconds, audio_codec AS audioCodec, audio_sample_rate AS audioSampleRate, audio_channels AS audioChannels, audio_size_bytes AS audioSizeBytes, media_verified_at AS mediaVerifiedAt, transcript_model AS transcriptModel, transcript_language AS transcriptLanguage, transcript_segment_count AS transcriptSegmentCount, transcript_size_bytes AS transcriptSizeBytes, transcript_sha256 AS transcriptSha256, transcript_verified_at AS transcriptVerifiedAt, candidate_generation_id AS candidateGenerationId, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2",
  )
    .bind(user.id, limit)
    .all();
  return c.json({ jobs: result.results });
});

app.get("/api/jobs/:jobId", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, source_id AS sourceId, source_duration_seconds AS sourceDurationSeconds, source_published_at AS sourcePublishedAt, source_verified_at AS sourceVerifiedAt, source_asset_id AS sourceAssetId, media_container AS mediaContainer, media_video_codec AS mediaVideoCodec, media_source_audio_codec AS mediaSourceAudioCodec, media_width AS mediaWidth, media_height AS mediaHeight, media_duration_seconds AS mediaDurationSeconds, audio_codec AS audioCodec, audio_sample_rate AS audioSampleRate, audio_channels AS audioChannels, audio_size_bytes AS audioSizeBytes, media_verified_at AS mediaVerifiedAt, transcript_model AS transcriptModel, transcript_language AS transcriptLanguage, transcript_segment_count AS transcriptSegmentCount, transcript_size_bytes AS transcriptSizeBytes, transcript_sha256 AS transcriptSha256, transcript_verified_at AS transcriptVerifiedAt, candidate_generation_id AS candidateGenerationId, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = ?1 AND user_id = ?2",
  )
    .bind(c.req.param("jobId"), c.get("user").id)
    .first();
  if (!job) return jsonError(c, "Job not found.", 404);
  return c.json({ job });
});

app.get("/api/jobs/:jobId/candidates", async (c) => {
  const jobId = c.req.param("jobId");
  const userId = c.get("user").id;
  const exists = await c.env.DB.prepare(
    "SELECT id FROM jobs WHERE id = ?1 AND user_id = ?2",
  ).bind(jobId, userId).first();
  if (!exists) return jsonError(c, "Job not found.", 404);
  const result = await c.env.DB.prepare(
    "SELECT candidates.id, candidates.start_seconds AS startSeconds, candidates.end_seconds AS endSeconds, candidates.title, candidates.transcript_excerpt AS transcriptExcerpt, candidates.score, candidates.category, candidates.rationale, candidates.signals_json AS signalsJson, candidates.review_status AS reviewStatus, candidates.created_at AS createdAt FROM candidates INNER JOIN jobs ON jobs.id = candidates.job_id WHERE candidates.job_id = ?1 AND jobs.user_id = ?2 ORDER BY candidates.score DESC, candidates.start_seconds ASC LIMIT 100",
  ).bind(jobId, userId).all();
  return c.json({ candidates: result.results });
});

app.patch("/api/candidates/:candidateId", async (c) => {
  const body = await c.req.json<{ reviewStatus?: unknown }>().catch(() => null);
  if (body?.reviewStatus !== "selected" && body?.reviewStatus !== "rejected" && body?.reviewStatus !== "pending") {
    return jsonError(c, "Choose selected, rejected, or pending.", 400);
  }
  const result = await c.env.DB.prepare(
    "UPDATE candidates SET review_status = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = candidates.job_id AND jobs.user_id = ?3) RETURNING id, review_status AS reviewStatus",
  ).bind(body.reviewStatus, c.req.param("candidateId"), c.get("user").id).first();
  if (!result) return jsonError(c, "Candidate not found.", 404);
  return c.json({ candidate: result });
});

app.post("/api/candidates/:candidateId/render", async (c) => {
  const body = await c.req.json<{ captions?: unknown; resolution?: unknown }>().catch(() => null);
  const captions = body?.captions !== false;
  const resolution = body?.resolution === undefined ? "1080x1920" : body.resolution;
  if (resolution !== "1080x1920" && resolution !== "720x1280") {
    return jsonError(c, "Choose 1080x1920 or 720x1280 output resolution.", 400);
  }
  const userId = c.get("user").id;
  const candidateId = c.req.param("candidateId");
  const candidate = await c.env.DB.prepare(
    "SELECT candidates.id, candidates.job_id AS jobId, candidates.start_seconds AS startSeconds, candidates.end_seconds AS endSeconds, candidates.transcript_excerpt AS transcriptExcerpt FROM candidates INNER JOIN jobs ON jobs.id = candidates.job_id AND jobs.user_id = ?2 INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready' WHERE candidates.id = ?1 AND candidates.review_status = 'selected' AND jobs.transcript_verified_at IS NOT NULL",
  ).bind(candidateId, userId).first<{
    id: string; jobId: string; startSeconds: number; endSeconds: number; transcriptExcerpt: string | null;
  }>();
  if (!candidate) return jsonError(c, "Select a candidate from your own completed analysis before rendering.", 409);
  const existing = await c.env.DB.prepare(
    "SELECT id, job_id AS jobId, candidate_id AS candidateId, title, description, duration_seconds AS durationSeconds, aspect_ratio AS aspectRatio, status, progress, error_code AS errorCode, output_size_bytes AS outputSizeBytes, created_at AS createdAt, completed_at AS completedAt FROM clips WHERE candidate_id = ?1 AND user_id = ?2",
  ).bind(candidateId, userId).first();
  if (existing) return c.json({ clip: existing }, 200);

  const id = uuid();
  const mm = Math.floor(candidate.startSeconds / 60);
  const ss = Math.floor(candidate.startSeconds % 60);
  const title = `Highlight ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  const inserted = await c.env.DB.prepare(
    "INSERT INTO clips (id, job_id, user_id, candidate_id, output_key, title, description, duration_seconds, aspect_ratio, status, progress, render_options_json) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '9:16', 'queued', 0, ?9 WHERE EXISTS (SELECT 1 FROM candidates INNER JOIN jobs ON jobs.id = candidates.job_id AND jobs.user_id = ?3 INNER JOIN source_assets ON source_assets.id = jobs.source_asset_id AND source_assets.user_id = jobs.user_id AND source_assets.status = 'ready' WHERE candidates.id = ?4 AND candidates.review_status = 'selected' AND jobs.transcript_verified_at IS NOT NULL) ON CONFLICT(candidate_id) WHERE candidate_id IS NOT NULL DO NOTHING",
  ).bind(
    id, candidate.jobId, userId, candidate.id, `users/${userId}/clips/${id}.mp4`,
    title, candidate.transcriptExcerpt, candidate.endSeconds - candidate.startSeconds,
    JSON.stringify({ captions, resolution }),
  ).run();
  const clip = await c.env.DB.prepare(
    "SELECT id, job_id AS jobId, title, status, progress, error_code AS errorCode, duration_seconds AS durationSeconds, created_at AS createdAt FROM clips WHERE candidate_id = ?1 AND user_id = ?2",
  ).bind(candidateId, userId).first();
  if (!clip) return jsonError(c, "The render job could not be queued.", 409);
  return c.json({ clip }, inserted.meta.changes ? 202 : 200);
});

app.post("/api/clips/:clipId/cancel", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE clips SET cancel_requested = 1, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status IN ('queued','rendering')",
  ).bind(c.req.param("clipId"), c.get("user").id).run();
  if (!result.meta.changes) {
    const existing = await c.env.DB.prepare(
      "SELECT id, status FROM clips WHERE id = ?1 AND user_id = ?2",
    ).bind(c.req.param("clipId"), c.get("user").id).first();
    if (!existing) return jsonError(c, "Clip not found.", 404);
    return c.json({ clip: existing, cancelled: false });
  }
  return c.json({ clipId: c.req.param("clipId"), cancelled: true });
});

app.post("/api/clips/:clipId/retry", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE clips SET status = 'queued', progress = 0, error_code = NULL, cancel_requested = 0, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'failed' AND EXISTS (SELECT 1 FROM candidates WHERE candidates.id = clips.candidate_id AND candidates.review_status = 'selected')",
  ).bind(c.req.param("clipId"), c.get("user").id).run();
  if (!result.meta.changes) return jsonError(c, "Clip cannot be retried; it may not exist or may not be failed.", 409);
  return c.json({ clipId: c.req.param("clipId"), status: "queued" }, 202);
});

app.post("/api/jobs/:jobId/cancel", async (c) => {
  const user = c.get("user");
  const id = c.req.param("jobId");
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET cancel_requested = 1, status = CASE WHEN status IN ('queued','review') THEN 'cancelled' ELSE status END, stage = CASE WHEN status IN ('queued','review') THEN 'cancelled' ELSE 'cancellation_requested' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND (status IN ('queued','processing') OR (status = 'review' AND stage = 'awaiting_source_asset'))",
  )
    .bind(id, user.id)
    .run();

  if (!result.meta.changes) {
    const exists = await c.env.DB.prepare(
      "SELECT status FROM jobs WHERE id = ?1 AND user_id = ?2",
    )
      .bind(id, user.id)
      .first<{ status: string }>();
    if (!exists) return jsonError(c, "Job not found.", 404);
    return c.json({ jobId: id, status: exists.status, cancelled: false });
  }

  const updated = await c.env.DB.prepare(
    "SELECT status FROM jobs WHERE id = ?1 AND user_id = ?2",
  ).bind(id, user.id).first<{ status: string }>();
  return c.json({ jobId: id, status: updated?.status ?? "processing", cancelled: true });
});

app.post("/api/jobs/cancel-all", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET cancel_requested = 1, status = CASE WHEN status IN ('queued','review') THEN 'cancelled' ELSE status END, stage = CASE WHEN status IN ('queued','review') THEN 'cancelled' ELSE 'cancellation_requested' END, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND (status IN ('queued','processing') OR (status = 'review' AND stage = 'awaiting_source_asset'))",
  )
    .bind(c.get("user").id)
    .run();
  return c.json({ requestedCount: result.meta.changes ?? 0 });
});

app.get("/api/clips", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, job_id AS jobId, candidate_id AS candidateId, title, description, hashtags_json AS hashtagsJson, duration_seconds AS durationSeconds, aspect_ratio AS aspectRatio, status, progress, error_code AS errorCode, output_size_bytes AS outputSizeBytes, created_at AS createdAt, completed_at AS completedAt FROM clips WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ clips: result.results });
});

app.get("/api/clips/:clipId/download", async (c) => {
  const clip = await c.env.DB.prepare(
    "SELECT output_key AS outputKey, title FROM clips WHERE id = ?1 AND user_id = ?2 AND status = 'ready'",
  ).bind(c.req.param("clipId"), c.get("user").id).first<{ outputKey: string; title: string }>();
  if (!clip) return jsonError(c, "Ready clip not found.", 404);
  const object = await c.env.MEDIA.get(clip.outputKey);
  if (!object) return jsonError(c, "The rendered MP4 is not available in private storage.", 404);
  const safeName = clip.title.normalize("NFKC").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 80) || "clipforge-highlight";
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${safeName}.mp4"`,
      "Cache-Control": "private, no-store",
    },
  });
});

app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", message: error.message, path: c.req.path }));
  return c.json({ error: { message: "Internal server error." } }, 500);
});

export default { fetch: app.fetch };
