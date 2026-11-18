import {
  getGoogleCredentials,
  GOOGLE_SCOPES,
  type GoogleCredentials,
} from "../../integrations/google/credentials.ts";
import { type EnvSource, readEnv } from "../../utils/env.ts";
import { ServiceConfigurationError } from "../service-config.ts";
import {
  normalizeStorageKey,
  type StorageObjectHead,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

// Google Cloud Storage, through its JSON API with plain fetch: no SDK.
// Access tokens come from the app's shared Google credentials: on Cloud Run
// the service account the app runs as, anywhere else a service account key.
// That account needs roles/storage.objectAdmin on the bucket.
//
// The bucket should not be public. Nothing in it is given a public URL;
// every read goes through the app, which checks who is asking first.
//
// GCS_BUCKET names the bucket. GCS_PREFIX, when set, puts every object
// under that folder, so one bucket can hold more than one install.

const DEFAULT_API_URL = "https://storage.googleapis.com";
// A resumable upload is sent in pieces of this size. Google asks for a
// multiple of 256 KiB; 8 MiB keeps the number of requests low without
// holding much in memory.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type FetchLike = typeof fetch;

/** What the client needs from the credentials. Replaced in tests. */
export type GcsTokenSource = Pick<GoogleCredentials, "getAccessToken">;

/** A failed call to Cloud Storage. Only the status is kept: the body can echo what was sent. */
export class GcsRequestError extends Error {
  status: number;

  constructor(action: string, status: number) {
    super(`Google Cloud Storage ${action} failed with ${String(status)}.`);
    this.name = "GcsRequestError";
    this.status = status;
  }
}

export type GcsObjectMetadata = {
  contentType?: string;
  etag?: string;
  name: string;
  size: number;
  updated: Date;
};

export type GcsUploadResult = "stored" | "already-exists";

/** The calls to one bucket that the storage driver and the backup make. */
export type GcsClient = {
  bucket: string;
  deleteObject(name: string): Promise<"deleted" | "not-found">;
  /** The media download, or null when there is no such object. */
  download(name: string): Promise<Response | null>;
  getMetadata(name: string): Promise<GcsObjectMetadata | null>;
  list(options: {
    pageToken?: string;
    prefix?: string;
  }): Promise<{ items: GcsObjectMetadata[]; nextPageToken?: string }>;
  /**
   * Writes a whole object in one request. With ifAbsent, Cloud Storage
   * itself refuses to replace an object that is there (ifGenerationMatch=0),
   * so of two writers that arrive together exactly one is kept.
   */
  upload(
    name: string,
    body: Uint8Array | string,
    options: { contentType: string; ifAbsent?: boolean },
  ): Promise<GcsUploadResult>;
  /** Writes an object of unknown length as it is read, with a resumable upload. */
  uploadStream(
    name: string,
    body: AsyncIterable<Uint8Array>,
    options: { contentType: string },
  ): Promise<void>;
};

type CreateGcsClientOptions = {
  apiUrl?: string;
  bucket: string;
  credentials: GcsTokenSource;
  fetchImpl?: FetchLike;
};

function toBuffer(body: Uint8Array): Buffer {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function parseMetadata(value: unknown): GcsObjectMetadata {
  const item = value as {
    contentType?: unknown;
    etag?: unknown;
    name?: unknown;
    size?: unknown;
    updated?: unknown;
  };

  return {
    contentType:
      typeof item.contentType === "string" ? item.contentType : undefined,
    etag: typeof item.etag === "string" ? item.etag : undefined,
    name: String(item.name ?? ""),
    // The JSON API sends sizes as strings, since they can pass 2^53.
    size: Number(item.size ?? 0),
    updated: new Date(String(item.updated ?? 0)),
  };
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

export function createGcsClient({
  apiUrl = DEFAULT_API_URL,
  bucket,
  credentials,
  fetchImpl = fetch,
}: CreateGcsClientOptions): GcsClient {
  const base = apiUrl.replace(/\/+$/, "");
  const bucketPath = `b/${encodeURIComponent(bucket)}`;

  // An object's name goes into the path as one segment, so its slashes are
  // encoded too.
  function objectUrl(name: string, query = "") {
    return `${base}/storage/v1/${bucketPath}/o/${encodeURIComponent(name)}${query}`;
  }

  async function send(url: string, init: RequestInit = {}) {
    const token = await credentials.getAccessToken({
      scopes: [GOOGLE_SCOPES.devstorageReadWrite],
    });
    const headers = new Headers(init.headers);

    headers.set("authorization", `Bearer ${token}`);

    return fetchImpl(url, { ...init, headers });
  }

  async function fail(action: string, response: Response): Promise<never> {
    await discard(response);
    throw new GcsRequestError(action, response.status);
  }

  async function sendChunk(
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    total: number | null,
  ) {
    const range =
      chunk.byteLength === 0
        ? `bytes */${String(total ?? offset)}`
        : `bytes ${String(offset)}-${String(offset + chunk.byteLength - 1)}/${total === null ? "*" : String(total)}`;

    return send(sessionUrl, {
      body: toBuffer(chunk),
      headers: { "content-range": range },
      method: "PUT",
    });
  }

  return {
    bucket,
    async deleteObject(name) {
      const response = await send(objectUrl(name), { method: "DELETE" });

      if (response.status === 404) {
        await discard(response);
        return "not-found";
      }

      if (!response.ok) {
        return fail("delete", response);
      }

      await discard(response);
      return "deleted";
    },
    async download(name) {
      const response = await send(objectUrl(name, "?alt=media"));

      if (response.status === 404) {
        await discard(response);
        return null;
      }

      if (!response.ok) {
        return fail("download", response);
      }

      return response;
    },
    async getMetadata(name) {
      const response = await send(objectUrl(name));

      if (response.status === 404) {
        await discard(response);
        return null;
      }

      if (!response.ok) {
        return fail("metadata read", response);
      }

      return parseMetadata(await response.json());
    },
    async list({ pageToken, prefix }) {
      const query = new URLSearchParams({
        fields: "items(name,size,updated,contentType,etag),nextPageToken",
        maxResults: "1000",
      });

      if (prefix) {
        query.set("prefix", prefix);
      }

      if (pageToken) {
        query.set("pageToken", pageToken);
      }

      const response = await send(
        `${base}/storage/v1/${bucketPath}/o?${query.toString()}`,
      );

      if (!response.ok) {
        return fail("list", response);
      }

      const page = (await response.json()) as {
        items?: unknown[];
        nextPageToken?: unknown;
      };

      return {
        items: (page.items ?? []).map(parseMetadata),
        nextPageToken:
          typeof page.nextPageToken === "string"
            ? page.nextPageToken
            : undefined,
      };
    },
    async upload(name, body, { contentType, ifAbsent }) {
      const query = new URLSearchParams({ name, uploadType: "media" });

      if (ifAbsent) {
        query.set("ifGenerationMatch", "0");
      }

      const response = await send(
        `${base}/upload/storage/v1/${bucketPath}/o?${query.toString()}`,
        {
          body: typeof body === "string" ? body : toBuffer(body),
          headers: { "content-type": contentType },
          method: "POST",
        },
      );

      // 412: the precondition failed, so something is already stored there.
      if (ifAbsent && response.status === 412) {
        await discard(response);
        return "already-exists";
      }

      if (!response.ok) {
        return fail("upload", response);
      }

      await discard(response);
      return "stored";
    },
    async uploadStream(name, body, { contentType }) {
      const query = new URLSearchParams({ name, uploadType: "resumable" });
      const started = await send(
        `${base}/upload/storage/v1/${bucketPath}/o?${query.toString()}`,
        {
          body: JSON.stringify({ contentType }),
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-type": contentType,
          },
          method: "POST",
        },
      );

      if (!started.ok) {
        return fail("upload start", started);
      }

      const sessionUrl = started.headers.get("location");

      await discard(started);

      if (!sessionUrl) {
        throw new GcsRequestError("upload start", started.status);
      }

      // Bytes read but not yet taken by Cloud Storage. A full piece is sent
      // only once more is known to follow, so the last piece can say how
      // long the object is.
      let pending = new Uint8Array(0);
      let offset = 0;

      for await (const chunk of body) {
        const joined = new Uint8Array(pending.byteLength + chunk.byteLength);

        joined.set(pending);
        joined.set(chunk, pending.byteLength);
        pending = joined;

        while (pending.byteLength > UPLOAD_CHUNK_BYTES) {
          const piece = pending.subarray(0, UPLOAD_CHUNK_BYTES);
          const response = await sendChunk(sessionUrl, piece, offset, null);

          if (response.status !== 308) {
            return fail("upload", response);
          }

          // Range says how much has been kept so far ("bytes=0-N"). What it
          // does not cover is sent again with the next piece.
          const kept = /bytes=0-(\d+)/.exec(
            response.headers.get("range") ?? "",
          );
          const keptBytes = kept ? Number(kept[1]) + 1 : offset;

          await discard(response);

          // Nothing more taken: sending it again would go round forever.
          if (keptBytes <= offset) {
            throw new GcsRequestError("upload", response.status);
          }

          pending = pending.subarray(keptBytes - offset);
          offset = keptBytes;
        }
      }

      const last = await sendChunk(
        sessionUrl,
        pending,
        offset,
        offset + pending.byteLength,
      );

      if (!last.ok) {
        return fail("upload", last);
      }

      await discard(last);
    },
  };
}

/** The bucket and folder the app's files go in, from GCS_BUCKET and GCS_PREFIX. */
export function readGcsLocation(
  env: EnvSource = process.env,
): { bucket: string; prefix: string } | null {
  const bucket = readEnv(env, "GCS_BUCKET");

  return bucket
    ? { bucket, prefix: normalizeGcsPrefix(readEnv(env, "GCS_PREFIX")) }
    : null;
}

/** A folder inside a bucket as a name prefix: "" or "some/folder/". */
export function normalizeGcsPrefix(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/g, "");

  return trimmed ? `${normalizeStorageKey(trimmed)}/` : "";
}

type CreateGcsStorageServiceOptions = {
  client?: GcsClient;
  /** The app's shared credentials unless given; null when there are none. */
  credentials?: GcsTokenSource | null;
  env?: EnvSource;
};

export function createGcsStorageService({
  client,
  credentials = client ? null : getGoogleCredentials(),
  env = process.env,
}: CreateGcsStorageServiceOptions = {}): StorageService {
  const location = readGcsLocation(env);

  if (!location) {
    throw new ServiceConfigurationError("storage", ["GCS_BUCKET"]);
  }

  const { bucket, prefix } = location;
  let gcs = client;

  if (!gcs) {
    if (!credentials) {
      throw new ServiceConfigurationError("storage", [
        "GOOGLE_SERVICE_ACCOUNT_KEY",
      ]);
    }

    gcs = createGcsClient({ bucket, credentials });
  }

  const storage = gcs;

  function resolve(key: string) {
    const normalizedKey = normalizeStorageKey(key);

    return { name: `${prefix}${normalizedKey}`, normalizedKey };
  }

  async function download(key: string) {
    const { name, normalizedKey } = resolve(key);
    const response = await storage.download(name);

    if (!response) {
      throw new StorageObjectNotFoundError(normalizedKey);
    }

    return { normalizedKey, response };
  }

  function contentLengthOf(response: Response): number | undefined {
    const value = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );

    return Number.isFinite(value) ? value : undefined;
  }

  return {
    async deleteObject(key) {
      // An object that is already gone is what was asked for.
      await storage.deleteObject(resolve(key).name);
    },
    async getObject(key) {
      const { normalizedKey, response } = await download(key);
      const body = new Uint8Array(await response.arrayBuffer());

      return {
        body,
        bucketName: bucket,
        contentLength: body.byteLength,
        contentType: response.headers.get("content-type") ?? undefined,
        etag: response.headers.get("etag") ?? undefined,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, response } = await download(key);

      if (!response.body) {
        throw new GcsRequestError("download", response.status);
      }

      return {
        bucketName: bucket,
        contentLength: contentLengthOf(response),
        contentType: response.headers.get("content-type") ?? undefined,
        key: normalizedKey,
        stream: response.body,
      };
    },
    async headObject(key): Promise<StorageObjectHead> {
      const { name, normalizedKey } = resolve(key);
      const metadata = await storage.getMetadata(name);

      if (!metadata) {
        return { bucketName: bucket, exists: false, key: normalizedKey };
      }

      return {
        bucketName: bucket,
        contentLength: metadata.size,
        contentType: metadata.contentType,
        etag: metadata.etag,
        exists: true,
        key: normalizedKey,
      };
    },
    async putObject(input) {
      const { name, normalizedKey } = resolve(input.key);

      // With keepExisting, "already-exists" is the other writer's object,
      // which is kept, as on the other drivers.
      await storage.upload(name, input.body, {
        contentType: input.contentType,
        ifAbsent: input.keepExisting === true,
      });

      return { bucketName: bucket, key: normalizedKey };
    },
  };
}
