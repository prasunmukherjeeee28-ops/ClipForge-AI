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
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();
const SOURCE_ASSET_PART_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SOURCE_ASSET_USER_BYTES = 8 * 1024 * 1024 * 1024;
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
  const body = await c.req.text();
  const canonical = [timestamp, nonce.toLowerCase(), c.req.method.toUpperCase(), new URL(c.req.url).pathname, body].join("\n");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(canonical));
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

  c.set("processorBody", body);
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
      "INSERT INTO source_assets (id, user_id, object_key, filename, content_type, size_bytes, upload_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE COALESCE((SELECT SUM(size_bytes) FROM source_assets WHERE user_id = ?2 AND status IN ('uploading','ready')), 0) + ?6 <= ?8",
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
    "INSERT INTO source_asset_parts (asset_id, part_number, status, size_bytes) VALUES (?1, ?2, 'uploading', ?3) ON CONFLICT(asset_id, part_number) DO NOTHING",
  ).bind(assetId, partNumber, expectedBytes).run();
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
    "SELECT object_key AS objectKey, upload_id AS uploadId, size_bytes AS sizeBytes FROM source_assets WHERE id = ?1 AND user_id = ?2 AND status = 'uploading'",
  ).bind(assetId, c.get("user").id).first<{ objectKey: string; uploadId: string; sizeBytes: number }>();
  if (!asset) return jsonError(c, "Active source upload not found.", 404);

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

  let storedObject: R2Object;
  try {
    storedObject = await c.env.MEDIA.resumeMultipartUpload(asset.objectKey, asset.uploadId)
      .complete(parts.results.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
  } catch {
    return jsonError(c, "R2 could not finalize this upload. Check its parts and retry.", 409);
  }
  if (storedObject.size !== asset.sizeBytes) {
    await c.env.MEDIA.delete(asset.objectKey);
    await c.env.DB.prepare(
      "UPDATE source_assets SET status = 'failed', upload_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'uploading'",
    ).bind(assetId, c.get("user").id).run();
    return jsonError(c, "Stored file size did not match the declared size; upload rejected.", 409);
  }

  const completed = await c.env.DB.prepare(
    "UPDATE source_assets SET status = 'ready', upload_id = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status = 'uploading' AND upload_id = ?3",
  ).bind(assetId, c.get("user").id, asset.uploadId).run();
  if (!completed.meta.changes) return jsonError(c, "Upload state changed while finalizing. Refresh the asset status.", 409);
  return c.json({ assetId, status: "ready", sizeBytes: storedObject.size });
});

app.delete("/api/source-assets/:assetId", async (c) => {
  const assetId = c.req.param("assetId");
  const asset = await c.env.DB.prepare(
    "SELECT object_key AS objectKey, upload_id AS uploadId, status FROM source_assets WHERE id = ?1 AND user_id = ?2",
  ).bind(assetId, c.get("user").id).first<{ objectKey: string; uploadId: string | null; status: string }>();
  if (!asset) return jsonError(c, "Source asset not found.", 404);

  const activeJob = await c.env.DB.prepare(
    "SELECT id FROM jobs WHERE source_asset_id = ?1 AND status NOT IN ('failed','cancelled','completed') LIMIT 1",
  ).bind(assetId).first();
  if (activeJob) return jsonError(c, "This source file is attached to an active job and cannot be deleted yet.", 409);

  try {
    if (asset.status === "uploading" && asset.uploadId) {
      await c.env.MEDIA.resumeMultipartUpload(asset.objectKey, asset.uploadId).abort();
    } else if (asset.status === "ready") {
      await c.env.MEDIA.delete(asset.objectKey);
    }
  } catch {
    return jsonError(c, "Source storage could not be cleaned up. Retry deletion later.", 409);
  }
  await c.env.DB.prepare(
    "DELETE FROM source_assets WHERE id = ?1 AND user_id = ?2",
  ).bind(assetId, c.get("user").id).run();
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
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, source_id AS sourceId, source_duration_seconds AS sourceDurationSeconds, source_published_at AS sourcePublishedAt, source_verified_at AS sourceVerifiedAt, source_asset_id AS sourceAssetId, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2",
  )
    .bind(user.id, limit)
    .all();
  return c.json({ jobs: result.results });
});

app.get("/api/jobs/:jobId", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, source_id AS sourceId, source_duration_seconds AS sourceDurationSeconds, source_published_at AS sourcePublishedAt, source_verified_at AS sourceVerifiedAt, source_asset_id AS sourceAssetId, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = ?1 AND user_id = ?2",
  )
    .bind(c.req.param("jobId"), c.get("user").id)
    .first();
  if (!job) return jsonError(c, "Job not found.", 404);
  return c.json({ job });
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
    "SELECT id, job_id AS jobId, title, description, hashtags_json AS hashtagsJson, duration_seconds AS durationSeconds, aspect_ratio AS aspectRatio, created_at AS createdAt FROM clips WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ clips: result.results });
});

app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", message: error.message, path: c.req.path }));
  return c.json({ error: { message: "Internal server error." } }, 500);
});

export default { fetch: app.fetch };
