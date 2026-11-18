import { MAX_UPLOAD_SIZE_BYTES } from "../../../types/domain.ts";

// The Drive side of the add-on: which selected files can be sent for
// signature, and reading a PDF or Word file's bytes as the person using
// the add-on.
//
// The add-on asks only for drive.file, so it can open a file once the user
// has given it that file. Drive says whether it has, per selected item, as
// addonHasFileScopePermission; when it has not, the card asks for it with
// the requestFileScope host action
// (https://developers.google.com/workspace/add-ons/drive/drive-actions).
// A Google Doc is exported to PDF by Drive itself (convert.ts); a PDF or
// Word file is downloaded here and converted the same way as a Gmail
// attachment.

const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";

export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

const DRIVE_SIGNABLE = new Map<string, DriveFileKind>([
  [GOOGLE_DOC_MIME_TYPE, "google-doc"],
  ["application/pdf", "pdf"],
  ["application/msword", "word"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "word",
  ],
]);

export type DriveFileKind = "google-doc" | "pdf" | "word";

/** What a Drive file is, for sending, or null when it cannot be sent. */
export function driveFileKind(mimeType: string): DriveFileKind | null {
  return DRIVE_SIGNABLE.get(mimeType.trim().toLowerCase()) ?? null;
}

export class DriveApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
  }
}

type FetchLike = typeof fetch;

/** A file's contents, for a PDF or Word file the add-on was given. */
export async function downloadDriveFile(
  fileId: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  maxSizeBytes = MAX_UPLOAD_SIZE_BYTES,
): Promise<Buffer> {
  let response: Response;

  try {
    response = await fetchImpl(
      `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    throw new DriveApiError("Google Drive could not be reached.", null);
  }

  if (!response.ok) {
    throw new DriveApiError(
      `Google Drive answered with ${String(response.status)}.`,
      response.status,
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "0");

  if (declared > maxSizeBytes) {
    throw new DriveApiError("The file is larger than an upload may be.", 413);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.byteLength > maxSizeBytes) {
    throw new DriveApiError("The file is larger than an upload may be.", 413);
  }

  return bytes;
}

export type DriveFileMetadata = { id: string; mimeType: string; name: string };

/**
 * A file's name and type, read as the user. A 403 or 404 here means the
 * add-on has not been given the file yet (drive.file).
 */
export async function getDriveFileMetadata(
  fileId: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFileMetadata> {
  let response: Response;

  try {
    response = await fetchImpl(
      `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    throw new DriveApiError("Google Drive could not be reached.", null);
  }

  if (!response.ok) {
    throw new DriveApiError(
      `Google Drive answered with ${String(response.status)}.`,
      response.status,
    );
  }

  const body = (await response.json()) as Partial<DriveFileMetadata>;

  return {
    id: typeof body.id === "string" ? body.id : fileId,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "",
    name: typeof body.name === "string" && body.name ? body.name : "Untitled",
  };
}
