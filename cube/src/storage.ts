/**
 * Media storage: a setting, not a fork. Two built-in adapters -
 * S3-compatible (any endpoint: MinIO, versitygw, AWS) and a local directory
 * for zero-infrastructure wikis. The interface stays the seam for custom
 * backends.
 *
 * The S3 adapter is dependency-free (SigV4 via node:crypto + fetch) so cube
 * doesn't drag the AWS SDK into every host; multipart uploads for the 60GB
 * parity bar are the host's concern via @aws-sdk/lib-storage until cube
 * ships its own multipart path (tracked for the media milestone).
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type StoragePutMeta = {
  contentType?: string;
  size?: number;
  /** Content-Disposition filename for anonymous downloads. */
  downloadName?: string;
};

export type CubeStorageAdapter = {
  put(key: string, body: Readable | Uint8Array, meta?: StoragePutMeta): Promise<void>;
  get(key: string): Promise<{ body: Readable; contentType?: string; size?: number } | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Public URL for direct serving, or null to stream through the app. */
  publicUrl(key: string): string | null;
};

/* ---- local directory ------------------------------------------------------ */

export type LocalDirStorageOptions = {
  dir: string;
  /** Base URL if the directory is served statically; else null = stream. */
  publicBase?: string;
};

export function localDirStorage(opts: LocalDirStorageOptions): CubeStorageAdapter {
  const safePath = (key: string): string => {
    const p = normalize(join(opts.dir, key));
    if (!p.startsWith(normalize(opts.dir) + sep)) throw new Error(`unsafe storage key: ${key}`);
    return p;
  };

  return {
    async put(key, body, _meta) {
      const path = safePath(key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      if (body instanceof Uint8Array) {
        await writeFile(tmp, body);
      } else {
        await pipeline(body, createWriteStream(tmp));
      }
      await rename(tmp, path);
    },
    async get(key) {
      const path = safePath(key);
      try {
        const s = await stat(path);
        return { body: createReadStream(path), size: s.size };
      } catch {
        return null;
      }
    },
    async has(key) {
      return existsSync(safePath(key));
    },
    async delete(key) {
      await unlink(safePath(key)).catch(() => {});
    },
    publicUrl(key) {
      return opts.publicBase ? `${opts.publicBase.replace(/\/$/, "")}/${encodeKey(key)}` : null;
    },
  };
}

/* ---- S3-compatible -------------------------------------------------------- */

export type S3StorageOptions = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  /** Key prefix inside the bucket, e.g. "cube/". */
  prefix?: string;
  /** Public gateway base (e.g. https://files.hiddenpalace.org); null = stream. */
  publicBase?: string | null;
  forcePathStyle?: boolean;
  /** Skip TLS verification (self-signed internal MinIO). */
  insecureTls?: boolean;
};

export function s3Storage(opts: S3StorageOptions): CubeStorageAdapter {
  const region = opts.region ?? "us-east-1";
  const endpoint = new URL(opts.endpoint);
  const pathStyle = opts.forcePathStyle ?? true;
  const prefix = opts.prefix ?? "";

  const objectUrl = (key: string): URL => {
    const full = `${prefix}${key}`;
    const u = new URL(endpoint.toString());
    if (pathStyle) {
      u.pathname = `/${opts.bucket}/${encodeKey(full)}`;
    } else {
      u.hostname = `${opts.bucket}.${u.hostname}`;
      u.pathname = `/${encodeKey(full)}`;
    }
    return u;
  };

  const request = async (
    method: string,
    key: string,
    init: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const url = objectUrl(key);
    const headers = signV4({
      method,
      url,
      region,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      body: init.body,
      headers: init.headers ?? {},
    });
    const options: Record<string, unknown> = { method, headers };
    if (init.body !== undefined) {
      options.body = init.body;
      options.duplex = "half";
    }
    if (opts.insecureTls) options.dispatcher = await insecureDispatcher();
    return fetch(url, options as Parameters<typeof fetch>[1]);
  };

  return {
    async put(key, body, meta = {}) {
      // SigV4 with UNSIGNED-PAYLOAD would allow streaming; buffering keeps the
      // signature simple and correct for now. Large-file multipart is a
      // tracked follow-up for the media milestone.
      const buf = body instanceof Uint8Array ? body : await collect(body);
      const headers: Record<string, string> = {};
      if (meta.contentType) headers["content-type"] = meta.contentType;
      if (meta.downloadName) {
        headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(meta.downloadName)}`;
      }
      const res = await request("PUT", key, { body: buf, headers });
      if (!res.ok) throw new Error(`s3 put failed: ${res.status} ${await res.text()}`);
    },
    async get(key) {
      const res = await request("GET", key);
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`s3 get failed: ${res.status}`);
      return {
        body: Readable.fromWeb(res.body as import("stream/web").ReadableStream),
        contentType: res.headers.get("content-type") ?? undefined,
        size: res.headers.has("content-length") ? Number(res.headers.get("content-length")) : undefined,
      };
    },
    async has(key) {
      const res = await request("HEAD", key);
      return res.ok;
    },
    async delete(key) {
      const res = await request("DELETE", key);
      if (!res.ok && res.status !== 404) throw new Error(`s3 delete failed: ${res.status}`);
    },
    publicUrl(key) {
      if (!opts.publicBase) return null;
      return `${opts.publicBase.replace(/\/$/, "")}/${encodeKey(`${prefix}${key}`)}`;
    },
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function collect(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

let cachedDispatcher: unknown;
async function insecureDispatcher(): Promise<unknown> {
  if (!cachedDispatcher) {
    const { Agent } = await import("undici");
    cachedDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return cachedDispatcher;
}

/* ---- AWS SigV4 (self-contained) ------------------------------------------- */

type SignInput = {
  method: string;
  url: URL;
  region: string;
  accessKey: string;
  secretKey: string;
  body?: Uint8Array;
  headers: Record<string, string>;
};

export function signV4(input: SignInput): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";

  const payloadHash = createHash("sha256")
    .update(input.body ?? new Uint8Array(0))
    .digest("hex");

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((h) => {
    const value = Object.entries(headers).find(([k]) => k.toLowerCase() === h)![1];
    return `${h}:${value.trim()}\n`;
  });
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    input.url.pathname.split("/").map(encodeRfc3986).join("/"),
    input.url.searchParams.toString(),
    canonicalHeaders.join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const kDate = createHmac("sha256", `AWS4${input.secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(input.region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
