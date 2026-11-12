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
  const signature = hexToBytes(c.req.header("X-Processor-Signature") ?? "");
  if (!secret || !/^\d{10}$/.test(timestamp) || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const body = await c.req.text();
  const canonical = [timestamp, c.req.method.toUpperCase(), new URL(c.req.url).pathname, body].join("\n");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(canonical));
  if (valid) c.set("processorBody", body);
  return valid;
}

function parseProcessorBody<T>(c: AppContext): T | null {
  try { return JSON.parse(c.get("processorBody")) as T; } catch { return null; }
}

function jsonError(c: AppContext, message: string, status: 400 | 401 | 403 | 404 | 500 | 503) {
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
  if (!c.env.PROCESSOR_SHARED_SECRET) return jsonError(c, "Processor authentication is not configured.", 503);
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
    "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND cancel_requested = 1 AND lease_expires_at < CURRENT_TIMESTAMP",
  ).run();
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'failed', stage = 'failed', error_code = 'retries_exhausted', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND lease_expires_at < CURRENT_TIMESTAMP AND attempt_count >= max_attempts",
  ).run();
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'queued', stage = 'queued', error_code = 'lease_expired', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND lease_expires_at < CURRENT_TIMESTAMP AND attempt_count < max_attempts AND cancel_requested = 0",
  ).run();

  const leaseId = uuid();
  const leaseToken = uuid() + uuid();
  const leaseTokenHash = await sha256Hex(leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET status = 'processing', stage = 'claimed', attempt_count = attempt_count + 1, lease_id = ?1, lease_token_hash = ?2, lease_expires_at = datetime('now', '+90 seconds'), last_heartbeat_at = CURRENT_TIMESTAMP, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND cancel_requested = 0 ORDER BY created_at ASC LIMIT 1) AND status = 'queued' RETURNING id, user_id AS userId, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, options_json AS optionsJson, attempt_count AS attemptCount",
  ).bind(leaseId, leaseTokenHash).first<{
    id: string; userId: string; sourceUrl: string; sourcePlatform: string;
    sourceType: string; optionsJson: string; attemptCount: number;
  }>();

  if (!job) return c.json({ job: null });
  return c.json({ job, lease: { leaseId, leaseToken, expiresInSeconds: 90 } });
});

app.post("/internal/processor/heartbeat", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid heartbeat payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const job = await c.env.DB.prepare(
    "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds'), last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing' RETURNING cancel_requested AS cancelRequested, lease_expires_at AS leaseExpiresAt",
  ).bind(body.jobId, body.leaseId, tokenHash).first<{ cancelRequested: number; leaseExpiresAt: string }>();
  if (!job) return jsonError(c, "Lease is no longer valid.", 409);
  return c.json({ ok: true, cancelRequested: job.cancelRequested === 1, leaseExpiresAt: job.leaseExpiresAt });
});

app.post("/internal/processor/progress", async (c) => {
  const body = parseProcessorBody<{
    jobId?: string; leaseId?: string; leaseToken?: string; stage?: string; progress?: number;
  }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken || typeof body.stage !== "string" ||
      body.stage.length < 1 || body.stage.length > 60 || !Number.isInteger(body.progress) ||
      (body.progress ?? -1) < 0 || (body.progress ?? 101) > 99) {
    return jsonError(c, "Invalid progress payload.", 400);
  }
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET stage = ?1, progress = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3 AND lease_id = ?4 AND lease_token_hash = ?5 AND status = 'processing' AND cancel_requested = 0",
  ).bind(body.stage, body.progress, body.jobId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Lease is invalid or cancellation was requested.", 409);
  return c.json({ ok: true });
});

app.post("/internal/processor/release", async (c) => {
  const body = parseProcessorBody<{ jobId?: string; leaseId?: string; leaseToken?: string }>(c);
  if (!body?.jobId || !body.leaseId || !body.leaseToken) return jsonError(c, "Invalid release payload.", 400);
  const tokenHash = await sha256Hex(body.leaseToken);
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END, stage = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END, progress = CASE WHEN cancel_requested = 1 THEN progress ELSE 0 END, attempt_count = CASE WHEN cancel_requested = 1 THEN attempt_count ELSE MAX(0, attempt_count - 1) END, lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND lease_id = ?2 AND lease_token_hash = ?3 AND status = 'processing'",
  ).bind(body.jobId, body.leaseId, tokenHash).run();
  if (!result.meta.changes) return jsonError(c, "Lease is no longer valid.", 409);
  return c.json({ ok: true, released: true });
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
    } else if (existing.email !== email) {
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

app.post("/api/jobs", async (c) => {
  const body = await c.req.json<{ urls?: unknown; options?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 20) {
    return jsonError(c, "Provide between 1 and 20 video or stream URLs.", 400);
  }

  const urls = body.urls.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (urls.some((url) => !url) || new Set(urls).size !== urls.length) {
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
  const created: Array<{ id: string; status: "queued"; sourcePlatform: string }> = [];

  for (const item of parsed) {
    const id = uuid();
    const platform = item.platform as "youtube" | "twitch";
    await c.env.DB.prepare(
      "INSERT INTO jobs (id, user_id, source_url, source_platform, options_json) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(id, user.id, item.url, platform, JSON.stringify(safeOptions))
      .run();
    created.push({ id, status: "queued", sourcePlatform: platform });
  }

  return c.json({ jobs: created }, 202);
});

app.get("/api/jobs", async (c) => {
  const user = c.get("user");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
  const result = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2",
  )
    .bind(user.id, limit)
    .all();
  return c.json({ jobs: result.results });
});

app.get("/api/jobs/:jobId", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = ?1 AND user_id = ?2",
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
    "UPDATE jobs SET cancel_requested = 1, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, stage = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancellation_requested' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND user_id = ?2 AND status IN ('queued','processing')",
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
 
  return c.json({ jobId: id, status: "cancellation_requested", cancelled: true });
});

app.post("/api/jobs/cancel-all", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET cancel_requested = 1, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, stage = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancellation_requested' END, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND status IN ('queued','processing')",
  )
    .bind(c.get("user").id)
    .run();
  return c.json({ cancelledCount: result.meta.changes ?? 0 });
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
