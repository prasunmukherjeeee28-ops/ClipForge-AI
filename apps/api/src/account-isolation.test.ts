import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    const identity = token === "alice-token"
      ? { sub: "access-alice", email: "alice@example.test" }
      : token === "bob-token"
        ? { sub: "access-bob", email: "bob@example.test" }
        : null;
    if (!identity) throw new Error("invalid test token");
    return { payload: identity };
  }),
}));

import worker from "./index";

type User = { id: string; email: string; authSubject: string };
type OwnedRecord = { id: string; user_id: string; [key: string]: unknown };

const users: User[] = [
  { id: "user-alice", email: "alice@example.test", authSubject: "access-alice" },
  { id: "user-bob", email: "bob@example.test", authSubject: "access-bob" },
];
const jobs: OwnedRecord[] = [
  { id: "job-alice", user_id: "user-alice", source_url: "https://youtu.be/aaaaaaaaaaa" },
  { id: "job-bob", user_id: "user-bob", source_url: "https://youtu.be/bbbbbbbbbbb" },
];
const assets: OwnedRecord[] = [
  { id: "asset-alice", user_id: "user-alice", filename: "alice.mp4", status: "ready" },
  { id: "asset-bob", user_id: "user-bob", filename: "bob.mp4", status: "ready" },
];
const clips: OwnedRecord[] = [
  { id: "clip-alice", user_id: "user-alice", title: "Alice clip", output_key: "clips/user-alice/a.mp4" },
  { id: "clip-bob", user_id: "user-bob", title: "Bob clip", output_key: "clips/user-bob/b.mp4" },
];

function makeDatabase() {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>() => {
        if (sql.includes("FROM users WHERE email")) {
          const user = users.find((entry) => entry.email === values[0]);
          return (user ? { authSubject: user.authSubject } : null) as T | null;
        }
        if (sql.includes("FROM users WHERE auth_subject")) {
          const user = users.find((entry) => entry.authSubject === values[0]);
          return (user ? { id: user.id, email: user.email } : null) as T | null;
        }
        if (sql.includes("FROM jobs WHERE id")) {
          const job = jobs.find((entry) => entry.id === values[0] && entry.user_id === values[1]);
          return (job ?? null) as T | null;
        }
        if (sql.includes("FROM source_assets WHERE id")) {
          const asset = assets.find((entry) => entry.id === values[0] && entry.user_id === values[1]);
          return (asset ?? null) as T | null;
        }
        if (sql.includes("FROM clips WHERE id")) {
          const clip = clips.find((entry) => entry.id === values[0] && entry.user_id === values[1]);
          return (clip ? { outputKey: clip.output_key, title: clip.title } : null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
        if (sql.includes("FROM jobs WHERE user_id")) {
          return { results: jobs.filter((entry) => entry.user_id === values[0]) as T[] };
        }
        if (sql.includes("FROM source_assets WHERE user_id")) {
          return { results: assets.filter((entry) => entry.user_id === values[0]) as T[] };
        }
        if (sql.includes("FROM clips WHERE user_id")) {
          return { results: clips.filter((entry) => entry.user_id === values[0]) as T[] };
        }
        if (sql.includes("FROM candidates")) return { results: [] as T[] };
        if (sql.includes("FROM source_asset_parts")) return { results: [] as T[] };
        return { results: [] as T[] };
      },
      run: async () => ({ meta: { changes: 0 } }),
    };
    return statement;
  };
  return { prepare, batch: async () => ({ success: true, results: [] }) } as unknown as D1Database;
}

const env = {
  DB: makeDatabase(),
  ACCESS_TEAM_DOMAIN: "clipforge.example.cloudflareaccess.com",
  ACCESS_AUD: "clipforge-test-audience",
  ALLOWED_EMAILS: "alice@example.test,bob@example.test",
};

async function request(path: string, token: "alice-token" | "bob-token") {
  return worker.fetch(new Request(`https://clipforge.test${path}`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  }), env as never, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("two-account data isolation", () => {
  it("returns only the authenticated user's jobs and source assets", async () => {
    const aliceJobs = await (await request("/api/jobs", "alice-token")).json() as { jobs: OwnedRecord[] };
    const bobJobs = await (await request("/api/jobs", "bob-token")).json() as { jobs: OwnedRecord[] };
    const aliceAssets = await (await request("/api/source-assets", "alice-token")).json() as { assets: OwnedRecord[] };
    const bobAssets = await (await request("/api/source-assets", "bob-token")).json() as { assets: OwnedRecord[] };

    expect(aliceJobs.jobs.map((item) => item.id)).toEqual(["job-alice"]);
    expect(bobJobs.jobs.map((item) => item.id)).toEqual(["job-bob"]);
    expect(aliceAssets.assets.map((item) => item.id)).toEqual(["asset-alice"]);
    expect(bobAssets.assets.map((item) => item.id)).toEqual(["asset-bob"]);
  });

  it("returns 404 when the other account requests a job or its moments", async () => {
    expect((await request("/api/jobs/job-bob", "alice-token")).status).toBe(404);
    expect((await request("/api/jobs/job-bob/moments", "alice-token")).status).toBe(404);
    expect((await request("/api/jobs/job-alice", "bob-token")).status).toBe(404);
    expect((await request("/api/jobs/job-alice/moments", "bob-token")).status).toBe(404);
  });

  it("returns 404 when the other account requests a source asset", async () => {
    expect((await request("/api/source-assets/asset-bob", "alice-token")).status).toBe(404);
    expect((await request("/api/source-assets/asset-alice", "bob-token")).status).toBe(404);
  });

  it("returns only the authenticated user's clips", async () => {
    const alice = await (await request("/api/clips", "alice-token")).json() as { clips: OwnedRecord[] };
    const bob = await (await request("/api/clips", "bob-token")).json() as { clips: OwnedRecord[] };
    expect(alice.clips.map((item) => item.id)).toEqual(["clip-alice"]);
    expect(bob.clips.map((item) => item.id)).toEqual(["clip-bob"]);
  });

  it("blocks cross-account clip preview and download before storage access", async () => {
    for (const path of ["/api/clips/clip-bob/preview", "/api/clips/clip-bob/download"]) {
      expect((await request(path, "alice-token")).status).toBe(404);
    }
    for (const path of ["/api/clips/clip-alice/preview", "/api/clips/clip-alice/download"]) {
      expect((await request(path, "bob-token")).status).toBe(404);
    }
  });
});
