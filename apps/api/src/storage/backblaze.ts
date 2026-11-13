import { AwsClient } from "aws4fetch";

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string | null;
}

export interface MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, body: BodyInit): Promise<{ etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<{ size: number }>;
  abort(): Promise<void>;
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
const xmlValue = (xml: string, tag: string): string | null => {
  const match = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`).exec(xml);
  return match?.[1]?.trim() ?? null;
};
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export class BackblazeBucket {
  private readonly client: AwsClient;
  private readonly base: URL;

  constructor(private readonly config: ObjectStorageConfig) {
    this.base = new URL(config.endpoint.endsWith("/") ? config.endpoint : config.endpoint + "/");
    if (this.base.protocol !== "https:") throw new Error("Object storage endpoint must use HTTPS.");
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
    });
  }

  private url(key: string, query?: Record<string, string>): URL {
    const url = new URL(encodeURIComponent(this.config.bucket) + "/" + encodeKey(key), this.base);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async request(key: string, init: RequestInit = {}, query?: Record<string, string>): Promise<Response> {
    const response = await this.client.fetch(this.url(key, query), init);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Object storage request failed (${response.status}): ${detail}`);
    }
    return response;
  }

  async head(key: string): Promise<{ size: number; etag: string | null } | null> {
    const response = await this.client.fetch(this.url(key), { method: "HEAD" });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Object storage HEAD failed (${response.status}).`);
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      etag: response.headers.get("etag"),
    };
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoredObject | null> {
    const headers = new Headers();
    if (options?.range) {
      const { offset, length } = options.range;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1) {
        throw new Error("Invalid object byte range.");
      }
      headers.set("Range", `bytes=${offset}-${offset + length - 1}`);
    }
    const response = await this.client.fetch(this.url(key), { method: "GET", headers });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok && response.status !== 206) {
      throw new Error(`Object storage GET failed (${response.status}).`);
    }
    if (!response.body) throw new Error("Object storage returned an empty response body.");
    return {
      body: response.body as ReadableStream<Uint8Array>,
      size: Number(response.headers.get("content-length") ?? 0),
      etag: response.headers.get("etag"),
    };
  }

  async delete(key: string): Promise<void> {
    await this.request(key, { method: "DELETE" });
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<MultipartUpload> {
    const headers = new Headers();
    if (options?.httpMetadata?.contentType) headers.set("Content-Type", options.httpMetadata.contentType);
    for (const [name, value] of Object.entries(options?.customMetadata ?? {})) {
      if (!/^[a-zA-Z0-9-]{1,60}$/.test(name) || value.length > 512) throw new Error("Invalid object metadata.");
      headers.set(`x-amz-meta-${name.toLowerCase()}`, value);
    }
    const response = await this.request(key, { method: "POST", headers }, { uploads: "" });
    const uploadId = xmlValue(await response.text(), "UploadId");
    if (!uploadId) throw new Error("Object storage did not return a multipart upload ID.");
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    const partUrl = (partNumber: number) => this.url(key, { partNumber: String(partNumber), uploadId });
    return {
      uploadId,
      uploadPart: async (partNumber, body) => {
        if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("Invalid multipart part number.");
        const response = await this.client.fetch(partUrl(partNumber), { method: "PUT", body });
        if (!response.ok) throw new Error(`Multipart part upload failed (${response.status}).`);
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("Object storage did not return a part ETag.");
        return { etag };
      },
      complete: async (parts) => {
        if (!parts.length || parts.length > 10000) throw new Error("Invalid multipart completion list.");
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        if (ordered.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
          throw new Error("Multipart parts must be contiguous and include ETags.");
        }
        const body = `<CompleteMultipartUpload>${ordered.map((part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
        ).join("")}</CompleteMultipartUpload>`;
        const response = await this.request(key, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body,
        }, { uploadId });
        const xml = await response.text();
        if (/<(?:[A-Za-z0-9]+:)?Error>/.test(xml)) throw new Error("Object storage reported a multipart completion error.");
        const object = await this.head(key);
        if (!object) throw new Error("Completed object is not visible.");
        return { size: object.size };
      },
      abort: async () => {
        await this.request(key, { method: "DELETE" }, { uploadId });
      },
    };
  }
}

export function createBackblazeBucket(env: {
  B2_ENDPOINT?: string;
  B2_REGION?: string;
  B2_BUCKET?: string;
  B2_ACCESS_KEY_ID?: string;
  B2_SECRET_ACCESS_KEY?: string;
}): BackblazeBucket | null {
  const { B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY } = env;
  if (![B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY].every(
    (value) => typeof value === "string" && value.length > 0,
  )) return null;
  return new BackblazeBucket({
    endpoint: B2_ENDPOINT!,
    region: B2_REGION!,
    bucket: B2_BUCKET!,
    accessKeyId: B2_ACCESS_KEY_ID!,
    secretAccessKey: B2_SECRET_ACCESS_KEY!,
  });
}
