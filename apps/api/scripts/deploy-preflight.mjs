import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDirectory, "../wrangler.toml");

function readTomlString(content, section, key) {
  let currentSection = "";
  for (const line of content.split(/\r?\n/)) {
    const arraySection = line.match(/^\s*\[\[([^\]]+)\]\]\s*$/);
    const regularSection = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (arraySection) { currentSection = arraySection[1].trim(); continue; }
    if (regularSection) { currentSection = regularSection[1].trim(); continue; }
    if (currentSection !== section) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (assignment && assignment[1] === key) {
      return assignment[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    }
  }
  return null;
}

function hasPlaceholder(value) {
  return !value || /(?:YOUR_|SET_|CHANGE_ME|PLACEHOLDER|example\.com|example\.test)/i.test(value);
}

export function validateDeployConfig(content) {
  const errors = [];
  const root = (key) => readTomlString(content, "", key);
  const vars = (key) => readTomlString(content, "vars", key);
  const database = (key) => readTomlString(content, "d1_databases", key);

  if (root("name") !== "clipforge-api") errors.push('Worker name must be "clipforge-api".');
  if (database("binding") !== "DB") errors.push('D1 binding must be "DB".');
  if (database("database_name") !== "clipforge-app-db") errors.push('D1 database must be "clipforge-app-db"; do not point at the legacy database.');
  if (database("database_id") !== "664858ab-96b6-435a-96da-95cdbd110c5a") {
    errors.push("D1 database ID does not match the dedicated clipforge-app-db database.");
  }

  const teamDomain = (vars("ACCESS_TEAM_DOMAIN") || "").trim();
  if (hasPlaceholder(teamDomain) || teamDomain.includes("/") ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(teamDomain)) {
    errors.push("ACCESS_TEAM_DOMAIN must be the real Cloudflare Access team hostname (host only, no URL path).");
  }

  const audience = (vars("ACCESS_AUD") || "").trim();
  if (hasPlaceholder(audience) || audience.length < 16 || /\s/.test(audience)) {
    errors.push("ACCESS_AUD must be the real Cloudflare Access application audience tag.");
  }

  const region = (vars("B2_REGION") || "").trim();
  const bucket = (vars("B2_BUCKET") || "").trim();
  const endpoint = (vars("B2_ENDPOINT") || "").trim();
  if (hasPlaceholder(region) || !/^[a-z0-9-]{3,40}$/.test(region)) {
    errors.push("B2_REGION must be the real Backblaze S3 region identifier.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{4,48}[a-z0-9]$/.test(bucket) || hasPlaceholder(bucket)) {
    errors.push("B2_BUCKET must be the name of the private Backblaze bucket.");
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash || parsed.hostname !== "s3." + region + ".backblazeb2.com" || hasPlaceholder(endpoint)) {
      throw new Error("invalid endpoint");
    }
  } catch {
    errors.push("B2_ENDPOINT must be the matching HTTPS regional endpoint, for example https://s3.us-west-004.backblazeb2.com.");
  }

  return errors;
}

export function validateSecretList(secretListText) {
  let entries;
  try { entries = JSON.parse(secretListText); }
  catch { return ["Wrangler did not return valid JSON from the Worker secret list."]; }
  if (!Array.isArray(entries)) return ["Wrangler secret list must be a JSON array."];
  const names = new Set(entries
    .filter((entry) => entry && entry.type === "secret_text" && typeof entry.name === "string")
    .map((entry) => entry.name));
  const required = ["PROCESSOR_SHARED_SECRET", "B2_ACCESS_KEY_ID", "B2_SECRET_ACCESS_KEY", "INVITE_CODES"];
  return required.filter((name) => !names.has(name)).map((name) => "Missing Worker secret: " + name + ".");
}

async function runConfigCheck() {
  const content = await readFile(configPath, "utf8");
  const errors = validateDeployConfig(content);
  if (errors.length) {
    console.error("ClipForge deployment preflight failed:");
    for (const error of errors) console.error("  - " + error);
    console.error("\nFix apps/api/wrangler.toml before deploying. No deployment was attempted.");
    process.exitCode = 1;
    return;
  }
  console.log("ClipForge deployment configuration preflight passed.");
  console.log("This checks static configuration only; it does not prove that the B2 bucket or Cloudflare Access application exists.");
  console.log("After the first Worker deployment, run npm run verify:secrets before starting the processor.");
}

function runSecretCheck() {
  const result = spawnSync("npx", ["wrangler", "secret", "list", "--name", "clipforge-api", "--format", "json"], {
    cwd: resolve(scriptDirectory, ".."),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (result.error || result.status !== 0) {
    console.error("Could not read deployed Worker secret names. Confirm Wrangler authentication and that clipforge-api has been deployed.");
    if (result.stderr && result.stderr.trim()) console.error(result.stderr.trim());
    process.exitCode = 1;
    return;
  }
  const errors = validateSecretList(result.stdout);
  if (errors.length) {
    console.error("ClipForge secret verification failed:");
    for (const error of errors) console.error("  - " + error);
    console.error("Add missing values with wrangler secret put. Secret values are never printed by this check.");
    process.exitCode = 1;
    return;
  }
  console.log("All required Worker secret names are configured. Secret values were not read or displayed.");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--verify-secrets")) runSecretCheck();
  else await runConfigCheck();
}
