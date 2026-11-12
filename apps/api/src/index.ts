import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOB_QUEUE: Queue<JobMessage>;
  PROCESSOR?: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  PROCESSOR_SHARED_SECRET?: string;
};

type Variables = { user: { id: string; email: string; subject: string } };
type JobMessage = { jobId: string; userId: string; sourceUrl: string; sourcePlatform: "youtube" | "twitch" };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const uuid = () => crypto.randomUUID();
const jsonError = (c: { json: (data: unknown, status?: number) => Response }, message: string, status: number) =>
  c.json({ error: { message } }, status);

function allowedEmails(env: Bindings): Set<string> {
  return new Set(env.ALLOWED_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function sourcePlatform(value: string): "youtube" | "twitch" | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
  if (["twitch.tv", "www.twitch.tv", "m.twitch.tv", "clips.twitch.tv"].includes(host)) return "twitch";
  return null;
}

app.get("/health", (c) => c.json({ status: "ok", service: "clipforge-api", timestamp: new Date().toISOString() }));

app.use("/api/*", async (c, next) => {
  const domain = c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = c.env.ACCESS_AUD;
  if (!domain || domain.startsWith("YOUR_") || !audience || audience.startsWith("SET_")) {
    return jsonError(c, "Authentication is not configured.", 503);
  }

  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion) return jsonError(c, "Authentication required.", 401);

  try {
    const issuer = `https://${domain}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience });
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!subject || !email || !allowedEmails(c.env).has(email)) {
      return jsonError(c, "This account is not authorized to use ClipForge.", 403);
    }

    const existing = await c.env.DB.prepare(
      "SELECT id, email FROM users WHERE auth_subject = ?1 LIMIT 1"
    ).bind(subject).first<{ id: string; email: string }>();

    let userId = existing?.id;
    if (!userId) {
      userId = uuid();
      await c.env.DB.prepare(
        "INSERT INTO users (id, auth_subject, email, display_name) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(auth_subject) DO NOTHING"
      ).bind(userId, subject, email, typeof payload.name === "string" ? payload.name.slice(0, 100) : null).run();
      const inserted = await c.env.DB.prepare(
        "SELECT id, email FROM users WHERE auth_subject = ?1 LIMIT 1"
      ).bind(subject).first<{ id: string; email: string }>();
      if (!inserted) return jsonError(c, "Could not initialize account.", 500);
      userId = inserted.id;
    } else if (existing.email !== email) {
      await c.env.DB.prepare("UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(email, userId).run();
    }

    c.set("user", { id: userId, email, subject });
    await next();
  } catch {
    return jsonError(c, "Invalid or expired authentication token.", 401);
  }
});

app.get("/api/me", (c) => c.json({ user: { id: c.get("user").id, email: c.get("user").email } }));

app.post("/api/jobs", async (c) => {
  const body = await c.req.json<{ urls?: unknown; options?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 20) {
    return jsonError(c, "Provide between 1 and 20 video or stream URLs.", 400);
  }

  const urls = [...new Set(body.urls.filter((v): v is string => typeof v === "string").map((v) => v.trim()))];
  if (urls.length !== body.urls.length) return jsonError(c, "Every URL must be a unique string.", 400);

  const parsed = urls.map((url) => ({ url, platform: sourcePlatform(url) }));
  if (parsed.some((item) => !item.platform)) {
    return jsonError(c, "Only supported HTTPS YouTube and Twitch URLs are accepted.", 400);
  }

  const options = body.options && typeof body.options === "object" && !Array.isArray(body.options)
    ? body.options as Record<string, unknown> : {};
  const safeOptions = {
    captions: options.captions !== false,
    vertical: options.vertical !== false,
    reviewScores: options.reviewScores !== false,
    instruction: typeof options.instruction === "string" ? options.instruction.slice(0, 500) : "",
  };

  const user = c.get("user");
  const created: Array<{ id: string; status: string; sourcePlatform: string }> = [];
  for (const item of parsed) {
    const id = uuid();
    await c.env.DB.prepare(
      "INSERT INTO jobs (id, user_id, source_url, source_platform, options_json) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(id, user.id, item.url, item.platform, JSON.stringify(safeOptions)).run();
    try {
      await c.env.JOB_QUEUE.send({ jobId: id, userId: user.id, sourceUrl: item.url, sourcePlatform: item.platform });
      created.push({ id, status: "queued", sourcePlatform: item.platform });
    } catch {
      await c.env.DB.prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'queue_unavailable', stage = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
      ).bind(id, user.id).run();
      created.push({ id, status: "failed", sourcePlatform: item.platform });
    }
  }
  return c.json({ jobs: created }, 202);
});

app.get("/api/jobs", async (c) => {
  const user = c.get("user");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
  const result = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(user.id, limit).all();
  return c.json({ jobs: result.results });
});

app.get("/api/jobs/:jobId", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT id, source_url AS sourceUrl, source_platform AS sourcePlatform, source_type AS sourceType, title, status, progress, stage, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = ? AND user_id = ?"
  ).bind(c.req.param("jobId"), c.get("user").id).first();
  if (!job) return jsonError(c, "Job not found.", 404);
  return c.json({ job });
});

app.post("/api/jobs/:jobId/cancel", async (c) => {
  const user = c.get("user");
  const id = c.req.param("jobId");
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('queued','processing')"
  ).bind(id, user.id).run();
  if (!result.meta.changes) {
    const exists = await c.env.DB.prepare("SELECT status FROM jobs WHERE id = ? AND user_id = ?")
      .bind(id, user.id).first<{ status: string }>();
    if (!exists) return jsonError(c, "Job not found.", 404);
    return c.json({ jobId: id, status: exists.status, cancelled: false });
  }
  if (c.env.PROCESSOR) {
    c.executionCtx.waitUntil(c.env.PROCESSOR.fetch("https://processor.internal/internal/jobs/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", ...(c.env.PROCESSOR_SHARED_SECRET ? { authorization: `Bearer ${c.env.PROCESSOR_SHARED_SECRET}` } : {}) },
      body: JSON.stringify({ jobId: id, userId: user.id }),
    }).catch(() => new Response(null, { status: 502 })));
  }
  return c.json({ jobId: id, status: "cancelled", cancelled: true });
});

app.post("/api/jobs/cancel-all", async (c) => {
  const user = c.get("user");
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status IN ('queued','processing')"
  ).bind(user.id).run();
  return c.json({ cancelledCount: result.meta.changes ?? 0 });
});

app.get("/api/clips", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, job_id AS jobId, title, description, hashtags_json AS hashtagsJson, duration_seconds AS durationSeconds, aspect_ratio AS aspectRatio, created_at AS createdAt FROM clips WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
  ).bind(c.get("user").id).all();
  return c.json({ clips: result.results });
});

app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", message: error.message, path: c.req.path }));
  return c.json({ error: { message: "Internal server error." } }, 500);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Bindings) {
    for (const message of batch.messages) {
      const { jobId, userId, sourceUrl, sourcePlatform } = message.body;
      const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ? AND user_id = ?")
        .bind(jobId, userId).first<{ status: string }>();
      if (!row || row.status === "cancelled") { message.ack(); continue; }
      if (!env.PROCESSOR) {
        await env.DB.prepare(
          "UPDATE jobs SET status = 'failed', stage = 'failed', error_code = 'processor_not_configured', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'queued'"
        ).bind(jobId, userId).run();
        message.ack();
        continue;
      }
      try {
        const response = await env.PROCESSOR.fetch("https://processor.internal/internal/jobs", {
          method: "POST",
          headers: { "content-type": "application/json", ...(env.PROCESSOR_SHARED_SECRET ? { authorization: `Bearer ${env.PROCESSOR_SHARED_SECRET}` } : {}) },
          body: JSON.stringify({ jobId, userId, sourceUrl, sourcePlatform }),
        });
        if (response.ok) message.ack();
        else if (response.status >= 500) message.retry();
        else {
          await env.DB.prepare(
            "UPDATE jobs SET status = 'failed', stage = 'failed', error_code = 'processor_rejected_job', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
          ).bind(jobId, userId).run();
          message.ack();
        }
      } catch {
        message.retry();
      }
    }
  },
};
