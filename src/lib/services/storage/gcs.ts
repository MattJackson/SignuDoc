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
// How long a request may wait for Cloud Storage to answer. Generous enough
// for an 8 MiB piece; without one, a stalled connection would hold whatever
// is waiting on it (a database transaction, for one) for good.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// A resumable upload that is told "nothing kept" this many times in a row
// for the same piece gives up, instead of sending it for ever.
const MAX_STALLED_PIECES = 3;

type FetchLike = typeof fetch;

/** What the client needs from the credentials. Replaced in tests. */
export type GcsTokenSource = Pick<GoogleCredentials, "getAccessToken">;

/** A failed call to Cloud Storage. Only the status is kept: the body can echo what was sent. */
export class GcsRequestError extends Error {
  /** The HTTP status, or null when there was no answer in time. */
  status: number | null;

  constructor(action: string, status: number | null) {
    super(
      status === null
        ? `Google Cloud Storage ${action} got no answer in time.`
        : `Google Cloud Storage ${action} failed with ${String(status)}.`,
    );
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
  /**
   * The media download, or null when there is no such object. With
   * buffered, the whole body is read first, under the request's deadline,
   * for callers that need all of it (and may hold a transaction open).
   */
  download(
    name: string,
    options?: { buffered?: boolean },
  ): Promise<Response | null>;
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
  /** How long to wait for each answer. */
  requestTimeoutMs?: number;
};

// The same bytes, typed as fetch wants them: a view on a plain ArrayBuffer.
// Nothing here is ever backed by a SharedArrayBuffer.
function toBuffer(body: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    body.buffer as ArrayBuffer,
    body.byteOffset,
    body.byteLength,
  );
}

// The chunks as one piece of memory.
function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;

  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }

  return joined;
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

// Deadlines that are still running for responses whose body has yet to be
// read (see readWithinDeadline).
const deadlines = new WeakMap<
  Response,
  { release: () => void; signal: AbortSignal }
>();

function release(response: Response) {
  deadlines.get(response)?.release();
  deadlines.delete(response);
}

async function discard(response: Response) {
  release(response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Reads a response's body while the request's deadline is still running,
 * so a body that stops arriving fails like a request that is not answered.
 */
async function readWithinDeadline<T>(
  response: Response,
  read: () => Promise<T>,
): Promise<T> {
  const entry = deadlines.get(response);

  try {
    return await read();
  } catch (error) {
    if (entry?.signal.aborted) {
      throw new GcsRequestError("read", null);
    }

    throw error;
  } finally {
    release(response);
  }
}

export function createGcsClient({
  apiUrl = DEFAULT_API_URL,
  bucket,
  credentials,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: CreateGcsClientOptions): GcsClient {
  const base = apiUrl.replace(/\/+$/, "");
  const bucketPath = `b/${encodeURIComponent(bucket)}`;

  // An object's name goes into the path as one segment, so its slashes are
  // encoded too.
  function objectUrl(name: string, query = "") {
    return `${base}/storage/v1/${bucketPath}/o/${encodeURIComponent(name)}${query}`;
  }

  async function send(
    url: string,
    init: RequestInit = {},
    keepDeadline = false,
  ) {
    const token = await credentials.getAccessToken({
      scopes: [GOOGLE_SCOPES.devstorageReadWrite],
    });
    const headers = new Headers(init.headers);

    headers.set("authorization", `Bearer ${token}`);

    // The wait for an answer is bounded; a body already coming in is not
    // cut off, since a download can be as long as the person reading it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...init,
        headers,
        signal: init.signal ?? deadline.signal,
      });

      // The caller reads the body under the same deadline and then lets
      // it go; otherwise it ends with the wait for the headers.
      if (keepDeadline) {
        deadlines.set(response, {
          release: () => clearTimeout(timer),
          signal: deadline.signal,
        });
      } else {
        clearTimeout(timer);
      }

      return response;
    } catch (error) {
      clearTimeout(timer);

      if (deadline.signal.aborted) {
        throw new GcsRequestError("request", null);
      }

      throw error;
    }
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
    async download(name, { buffered = false } = {}) {
      const response = await send(objectUrl(name, "?alt=media"), {}, buffered);

      if (response.status === 404) {
        await discard(response);
        return null;
      }

      if (!response.ok) {
        return fail("download", response);
      }

      if (!buffered) {
        return response;
      }

      const bytes = await readWithinDeadline(response, () =>
        response.arrayBuffer(),
      );

      return new Response(bytes, {
        headers: response.headers,
        status: response.status,
      });
    },
    async getMetadata(name) {
      const response = await send(objectUrl(name), {}, true);

      if (response.status === 404) {
        await discard(response);
        return null;
      }

      if (!response.ok) {
        return fail("metadata read", response);
      }

      return parseMetadata(
        await readWithinDeadline(response, () => response.json()),
      );
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
        {},
        true,
      );

      if (!response.ok) {
        return fail("list", response);
      }

      const page = (await readWithinDeadline(response, () =>
        response.json(),
      )) as {
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

      // Bytes read but not yet taken by Cloud Storage, as the chunks they
      // arrived in. They are joined once per piece, not once per chunk. A
      // full piece is sent only once more is known to follow, so the last
      // piece can say how long the object is.
      let queued: Uint8Array[] = [];
      let queuedBytes = 0;
      let offset = 0;
      let stalled = 0;

      for await (const chunk of body) {
        queued.push(chunk);
        queuedBytes += chunk.byteLength;

        if (queuedBytes <= UPLOAD_CHUNK_BYTES) {
          continue;
        }

        let pending = joinChunks(queued, queuedBytes);

        while (pending.byteLength > UPLOAD_CHUNK_BYTES) {
          const piece = pending.subarray(0, UPLOAD_CHUNK_BYTES);
          const response = await sendChunk(sessionUrl, piece, offset, null);

          if (response.status !== 308) {
            return fail("upload", response);
          }

          // Range says how much has been kept so far ("bytes=0-N"). What it
          // does not cover is sent again with the next piece. No Range at
          // all means nothing has been kept yet.
          const kept = /bytes=0-(\d+)/.exec(
            response.headers.get("range") ?? "",
          );
          const keptBytes = kept ? Number(kept[1]) + 1 : offset;

          await discard(response);

          if (keptBytes <= offset) {
            // Nothing more taken: send the piece again, a few times at most.
            stalled += 1;

            if (stalled > MAX_STALLED_PIECES) {
              throw new GcsRequestError("upload", response.status);
            }

            continue;
          }

          stalled = 0;
          pending = pending.subarray(keptBytes - offset);
          offset = keptBytes;
        }

        queued = [pending];
        queuedBytes = pending.byteLength;
      }

      const rest = joinChunks(queued, queuedBytes);
      const last = await sendChunk(
        sessionUrl,
        rest,
        offset,
        offset + rest.byteLength,
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

  async function download(key: string, buffered = false) {
    const { name, normalizedKey } = resolve(key);
    const response = await storage.download(name, { buffered });

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
      const { normalizedKey, response } = await download(key, true);
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
