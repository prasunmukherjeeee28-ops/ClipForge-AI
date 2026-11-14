import { describe, expect, it } from "vitest";
import { validateDeployConfig, validateSecretList } from "./deploy-preflight.mjs";

const validConfig = [
  'name = "clipforge-api"',
  'main = "src/index.ts"',
  '[[d1_databases]]',
  'binding = "DB"',
  'database_name = "clipforge-app-db"',
  'database_id = "664858ab-96b6-435a-96da-95cdbd110c5a"',
  '[vars]',
  'ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"',
  'ACCESS_AUD = "0123456789abcdef0123456789abcdef"',
  'B2_ENDPOINT = "https://s3.us-west-004.backblazeb2.com"',
  'B2_REGION = "us-west-004"',
  'B2_BUCKET = "clipforge-private-media"',
].join("\n");

describe("deployment configuration preflight", () => {
  it("accepts a fully specified private workspace configuration", () => {
    expect(validateDeployConfig(validConfig)).toEqual([]);
  });

  it("rejects placeholder Access and storage settings", () => {
    const errors = validateDeployConfig(validConfig
      .replace("team.cloudflareaccess.com", "YOUR_TEAM.cloudflareaccess.com")
      .replace("0123456789abcdef0123456789abcdef", "SET_CLOUDFLARE_ACCESS_APPLICATION_AUD")
      .replace("https://s3.us-west-004.backblazeb2.com", "https://s3.SET_B2_REGION.backblazeb2.com")
      .replace("us-west-004", "SET_B2_REGION"));
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("does not require or validate an email allowlist", () => {
    expect(validateDeployConfig(validConfig)).not.toContain(
      "ALLOWED_EMAILS must contain exactly two distinct, real email addresses.",
    );
  });

  it("rejects a Backblaze endpoint that does not match the selected region", () => {
    const mismatch = validConfig.replace("s3.us-west-004", "s3.eu-central-003");
    expect(validateDeployConfig(mismatch)).toContain(
      "B2_ENDPOINT must be the matching HTTPS regional endpoint, for example https://s3.us-west-004.backblazeb2.com.",
    );
  });
});

describe("Worker secret preflight", () => {
  it("accepts all required secrets without reading their values", () => {
    expect(validateSecretList(JSON.stringify([
      { name: "PROCESSOR_SHARED_SECRET", type: "secret_text" },
      { name: "B2_ACCESS_KEY_ID", type: "secret_text" },
      { name: "B2_SECRET_ACCESS_KEY", type: "secret_text" },
      { name: "INVITE_CODES", type: "secret_text" },
    ]))).toEqual([]);
  });

  it("does not accept same-named plain-text variables as encrypted secrets", () => {
    expect(validateSecretList(JSON.stringify([
      { name: "INVITE_CODES", type: "plain_text" },
      { name: "PROCESSOR_SHARED_SECRET", type: "secret_text" },
      { name: "B2_ACCESS_KEY_ID", type: "secret_text" },
      { name: "B2_SECRET_ACCESS_KEY", type: "secret_text" },
    ]))).toEqual([]);
  });

  it("reports exactly which secret names are missing", () => {
    expect(validateSecretList(JSON.stringify([{ name: "B2_ACCESS_KEY_ID" }]))).toEqual([
      "Missing Worker secret: PROCESSOR_SHARED_SECRET.",
      "Missing Worker secret: B2_SECRET_ACCESS_KEY.",
      "Missing Worker secret: INVITE_CODES.",
    ]);
  });
});
