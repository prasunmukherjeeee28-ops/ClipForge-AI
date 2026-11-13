import { afterEach, describe, expect, it, vi } from "vitest";
import { BackblazeBucket, createBackblazeBucket } from "./backblaze";

const config = {
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucket: "clipforge-private-media",
  accessKeyId: "test-key-id",
  secretAccessKey: "test-secret-key",
};

afterEach(() => vi.unstubAllGlobals());

describe("BackblazeBucket configuration", () => {
  it("does not construct a client until all credentials are present", () => {
    expect(createBackblazeBucket({ B2_ENDPOINT: config.endpoint })).toBeNull();
  });

  it("rejects non-HTTPS and malformed bucket configuration", () => {
    expect(() => new BackblazeBucket({ ...config, endpoint: "http://localhost:9000" })).toThrow(/endpoint/);
    expect(() => new BackblazeBucket({ ...config, endpoint: "https://clipforge-private-media.s3.us-west-004.backblazeb2.com" })).toThrow(/regional S3 endpoint/);
    expect(() => new BackblazeBucket({ ...config, endpoint: "https://s3.us-west-004.backblazeb2.com/clipforge-private-media" })).toThrow(/without a bucket or path/);
    expect(() => new BackblazeBucket({ ...config, region: "us-east-005" })).toThrow(/regional S3 endpoint/);
    expect(() => new BackblazeBucket({ ...config, bucket: "tiny" })).toThrow(/bucket name/);
  });
});

describe("BackblazeBucket object operations", () => {
  it("uses path-style addressing and RFC3986-encodes object key segments", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/clipforge-private-media/clips/user%21%27%28%29%2A/file%20name.mp4");
      return new Response(null, { status: 200, headers: { "content-length": "123", etag: '"abc"' } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const bucket = new BackblazeBucket(config);
    await expect(bucket.head("clips/user!'()*/file name.mp4")).resolves.toEqual({ size: 123, etag: '"abc"' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects dot path segments before URL normalization can change the object key", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200, headers: { "content-length": "123", etag: '"safe"' } }));
    vi.stubGlobal("fetch", fetchMock);
    const bucket = new BackblazeBucket(config);

    await expect(bucket.head("clips/../private.mp4")).rejects.toThrow(/dot path segments/);
    await expect(bucket.get("clips/./private.mp4")).rejects.toThrow(/dot path segments/);
    await expect(bucket.head("clips/%2e%2e/private.mp4")).resolves.toEqual({
      size: 123,
      etag: '"safe"',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats missing objects as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(new BackblazeBucket(config).head("missing.mp4")).resolves.toBeNull();
    await expect(new BackblazeBucket(config).get("missing.mp4")).resolves.toBeNull();
  });

  it("requires a genuine, complete 206 response for ranged reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(4), {
      status: 200,
      headers: { "content-length": "4" },
    })));
    const bucket = new BackblazeBucket(config);
    await expect(bucket.get("clip.mp4", { range: { offset: 8, length: 4 } })).rejects.toThrow(/unexpected status/);
  });

  it("accepts a matching byte-range response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      expect(requestHeaders.get("range")).toBe("bytes=8-11");
      return new Response(new Uint8Array(4), {
        status: 206,
        headers: { "content-length": "4", "content-range": "bytes 8-11/20", etag: '"part"' },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new BackblazeBucket(config).get("clip.mp4", { range: { offset: 8, length: 4 } });
    expect(result?.size).toBe(4);
    expect(result?.etag).toBe('"part"');
  });

  it("validates multipart sequencing and completes only after object verification", async () => {
    const requests: Array<{ method: string; url: URL; body: BodyInit | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const requestBody = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      requests.push({ method, url, body: requestBody });
      if (method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>");
      }
      if (method === "PUT") return new Response(null, { status: 200, headers: { etag: '"part-etag"' } });
      if (method === "POST" && url.searchParams.has("uploadId")) return new Response("<CompleteMultipartUploadResult/>");
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "8" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bucket = new BackblazeBucket(config);
    const multipart = await bucket.createMultipartUpload("clips/a.mp4", {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { clipId: "clip-1" },
    });
    await expect(multipart.uploadPart(0, new Uint8Array([1]))).rejects.toThrow(/part number/);
    await expect(multipart.complete([{ partNumber: 2, etag: '"bad"' }])).rejects.toThrow(/contiguous/);
    await expect(multipart.uploadPart(1, new Uint8Array([1]))).resolves.toEqual({ etag: '"part-etag"' });
    await expect(multipart.complete([{ partNumber: 1, etag: '"part-etag"' }])).resolves.toEqual({ size: 8 });
    await multipart.abort();

    expect(requests.map((request) => request.method)).toEqual(["POST", "PUT", "POST", "HEAD", "DELETE"]);
    expect(String(requests[2].body)).toContain("<PartNumber>1</PartNumber>");
    expect(requests[0].url.search).toContain("uploads=");
    expect(requests[2].url.searchParams.get("uploadId")).toBe("upload-123");
  });
});
