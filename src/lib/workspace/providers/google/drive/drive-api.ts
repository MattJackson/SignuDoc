// The few Google Drive API v3 calls the app makes, with plain fetch and no
// Google SDK: reading a file, downloading or exporting it, uploading one
// with a resumable upload, and deleting one. The caller brings the access
// token, which is either a person's own (drive.file, see drive-tokens.ts)
// or the service account's (drive, for the Shared Drive export).
//
// Google's error bodies can echo what was sent, so an error keeps the HTTP
// status and Google's short reason code only (such as "notFound" or
// "exportSizeLimitExceeded"), never the message.

import {
  GOOGLE_MEDIA_TIMEOUT_MS,
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "../endpoints.ts";

export const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_BASE_URL =
  "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type FetchLike = typeof fetch;

export class DriveApiError extends Error {
  /** Google's HTTP status, or null when Google could not be reached. */
  readonly status: number | null;
  /** Google's reason code, when it gave one. */
  readonly reason: string | null;

  constructor(what: string, status: number | null, reason: string | null) {
    super(
      status === null
        ? `${what}: Google Drive could not be reached.`
        : `${what} failed with ${String(status)}${reason ? ` (${reason})` : ""}.`,
    );
    this.name = "DriveApiError";
    this.status = status;
    this.reason = reason;
  }
}

export class DriveFileTooLargeError extends Error {
  constructor(what: string) {
    super(`${what}: the file is larger than this site accepts.`);
    this.name = "DriveFileTooLargeError";
  }
}

async function readReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
    };
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status;

    return typeof reason === "string" && /^[A-Za-z_]{1,64}$/.test(reason)
      ? reason
      : null;
  } catch {
    return null;
  }
}

/**
 * Sends one request with the token, and throws a DriveApiError unless ok.
 * A request still unanswered after timeoutMs (the body included) ends as a
 * "could not be reached" error.
 */
export async function driveFetch(
  fetchImpl: FetchLike,
  accessToken: string,
  what: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GOOGLE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers);

  headers.set("authorization", `Bearer ${accessToken}`);

  let response: Response;

  try {
    response = await fetchImpl(googleUrl(url), {
      ...init,
      headers,
      signal: googleTimeoutSignal(timeoutMs, init.signal),
    });
  } catch {
    throw new DriveApiError(what, null, null);
  }

  if (!response.ok) {
    throw new DriveApiError(what, response.status, await readReason(response));
  }

  return response;
}

export async function driveJson<T>(
  fetchImpl: FetchLike,
  accessToken: string,
  what: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GOOGLE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const response = await driveFetch(
    fetchImpl,
    accessToken,
    what,
    url,
    init,
    timeoutMs,
  );

  return (await response.json()) as T;
}

/**
 * Reads a response body, refusing one larger than maxBytes, so a large
 * file in Drive cannot fill the server's memory.
 */
export async function readLimitedBytes(
  response: Response,
  maxBytes: number,
  what: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DriveFileTooLargeError(what);
  }

  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DriveFileTooLargeError(what);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

// The same bytes, typed as fetch wants them: a view on a plain ArrayBuffer.
function toBuffer(body: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    body.buffer as ArrayBuffer,
    body.byteOffset,
    body.byteLength,
  );
}

export type DriveFileMetadata = {
  appProperties?: Record<string, string>;
  mimeType?: string;
  name: string;
  parents?: string[];
};

/**
 * Uploads a file with a resumable upload: one request with the metadata,
 * then the bytes to the session Google hands back. Works for any size, and
 * for a conversion (metadata.mimeType a Google type, contentType the
 * file's own). Returns the fields asked for.
 */
export async function uploadDriveFile<T extends { id: string }>({
  accessToken,
  bytes,
  contentType,
  fetchImpl = fetch,
  fields = "id",
  metadata,
  supportsAllDrives = false,
}: {
  accessToken: string;
  bytes: Uint8Array;
  contentType: string;
  fetchImpl?: FetchLike;
  fields?: string;
  metadata: DriveFileMetadata;
  supportsAllDrives?: boolean;
}): Promise<T> {
  const query = new URLSearchParams({ fields, uploadType: "resumable" });

  if (supportsAllDrives) {
    query.set("supportsAllDrives", "true");
  }

  const started = await driveFetch(
    fetchImpl,
    accessToken,
    "Starting the Drive upload",
    `${DRIVE_UPLOAD_BASE_URL}/files?${query.toString()}`,
    {
      body: JSON.stringify(metadata),
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(bytes.byteLength),
        "x-upload-content-type": contentType,
      },
      method: "POST",
    },
  );
  const sessionUrl = started.headers.get("location");

  // Only a session on Google's upload host (or the test stand-in for it)
  // is given the token.
  if (
    !sessionUrl ||
    !(
      sessionUrl.startsWith(DRIVE_UPLOAD_BASE_URL) ||
      sessionUrl.startsWith(googleUrl(DRIVE_UPLOAD_BASE_URL))
    )
  ) {
    throw new DriveApiError("Starting the Drive upload", started.status, null);
  }

  return driveJson<T>(
    fetchImpl,
    accessToken,
    "Uploading to Drive",
    sessionUrl,
    {
      body: toBuffer(bytes),
      headers: { "content-type": contentType },
      method: "PUT",
    },
    GOOGLE_MEDIA_TIMEOUT_MS,
  );
}

/** Quotes a value for a Drive search query. */
export function quoteDriveQuery(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
