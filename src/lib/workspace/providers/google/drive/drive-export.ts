import type {
  ExecutedCopy,
  ExportRequest,
  ExportResult,
} from "../../../types.ts";
import {
  GOOGLE_SCOPES,
  type GoogleAccessTokenRequest,
} from "../credentials.ts";
import {
  DRIVE_API_BASE_URL,
  driveJson,
  GOOGLE_FOLDER_MIME_TYPE,
  quoteDriveQuery,
  uploadDriveFile,
  type FetchLike,
} from "./drive-api.ts";
import type { DriveLabelConfig } from "./drive-config.ts";
import {
  applyDriveLabel,
  buildLabelModification,
  getDriveLabel,
  type LabelValues,
} from "./drive-labels.ts";

// Executed copies in a Shared Drive: the sealed PDF and its audit
// certificate are put in the Shared Drive an administrator chose, by the
// site's service account (credentials.ts), in the folders the app worked
// out (workspace/exports.ts, which also keeps the outbox and retries).
//
// A retry never makes a second copy: each uploaded file carries
// appProperties with the envelope's id and the file's SHA-256, and the
// Shared Drive is searched for them before uploading. Every call passes
// supportsAllDrives=true.
//
// A label (drive-labels.ts) is put on the signed PDF after the upload when
// one is set up. A label that cannot be applied is reported as the
// metadata problem; the copy itself still counts as made.

const APP_PROPERTY_ENVELOPE = "signudocEnvelopeId";
const APP_PROPERTY_SHA256 = "signudocSha256";
const APP_PROPERTY_KIND = "signudocKind";
const MAX_PROBLEM_LENGTH = 500;

function listQuery(
  driveId: string,
  q: string,
  fields: string,
  extra: { orderBy?: string; pageSize?: string } = {},
): string {
  const query = new URLSearchParams({
    corpora: "drive",
    driveId,
    fields,
    includeItemsFromAllDrives: "true",
    pageSize: extra.pageSize ?? "10",
    q,
    supportsAllDrives: "true",
  });

  if (extra.orderBy) {
    query.set("orderBy", extra.orderBy);
  }

  return query.toString();
}

/** A file already uploaded for this envelope with these exact bytes. */
export async function findExportedFile(input: {
  accessToken: string;
  driveId: string;
  envelopeId: string;
  fetchImpl: FetchLike;
  sha256: string;
}): Promise<string | null> {
  const q = [
    `appProperties has { key=${quoteDriveQuery(APP_PROPERTY_ENVELOPE)} and value=${quoteDriveQuery(input.envelopeId)} }`,
    `appProperties has { key=${quoteDriveQuery(APP_PROPERTY_SHA256)} and value=${quoteDriveQuery(input.sha256)} }`,
    "trashed = false",
  ].join(" and ");
  const body = await driveJson<{ files?: Array<{ id: string }> }>(
    input.fetchImpl,
    input.accessToken,
    "Looking for an earlier copy",
    `${DRIVE_API_BASE_URL}/files?${listQuery(input.driveId, q, "files(id)")}`,
  );

  return body.files?.[0]?.id ?? null;
}

/** The folder for these names under the Shared Drive's root, made as needed. */
export async function ensureFolderPath(input: {
  accessToken: string;
  driveId: string;
  fetchImpl: FetchLike;
  folders: readonly string[];
}): Promise<string> {
  // A Shared Drive's root folder has the drive's own id.
  let parent = input.driveId;

  // Drive allows two folders of one name, so two exports that need a new
  // folder at the same moment can each make one. Every export uses the
  // oldest folder of the name, and a duplicate made in a race stays empty.
  async function oldestFolder(name: string): Promise<string | undefined> {
    const q = [
      `name = ${quoteDriveQuery(name)}`,
      `mimeType = ${quoteDriveQuery(GOOGLE_FOLDER_MIME_TYPE)}`,
      `${quoteDriveQuery(parent)} in parents`,
      "trashed = false",
    ].join(" and ");
    const found = await driveJson<{ files?: Array<{ id: string }> }>(
      input.fetchImpl,
      input.accessToken,
      "Looking for a folder",
      `${DRIVE_API_BASE_URL}/files?${listQuery(input.driveId, q, "files(id)", {
        orderBy: "createdTime",
        pageSize: "1",
      })}`,
    );

    return found.files?.[0]?.id;
  }

  for (const name of input.folders) {
    const existing = await oldestFolder(name);

    if (existing) {
      parent = existing;
      continue;
    }

    const created = await driveJson<{ id: string }>(
      input.fetchImpl,
      input.accessToken,
      "Making a folder",
      `${DRIVE_API_BASE_URL}/files?supportsAllDrives=true&fields=id`,
      {
        body: JSON.stringify({
          mimeType: GOOGLE_FOLDER_MIME_TYPE,
          name,
          parents: [parent],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    parent = (await oldestFolder(name)) ?? created.id;
  }

  return parent;
}

export type UploadedCopy = {
  id: string;
  kind: ExecutedCopy["kind"];
  /** Whether it was already there from an earlier try. */
  reused: boolean;
};

/**
 * Puts the copies in the Shared Drive under the folders, unless a copy with
 * the same envelope id and SHA-256 is already there.
 */
export async function uploadExecutedCopies(input: {
  accessToken: string;
  copies: readonly ExecutedCopy[];
  driveId: string;
  envelopeId: string;
  fetchImpl: FetchLike;
  folders: readonly string[];
}): Promise<{ files: UploadedCopy[]; folderId: string | null }> {
  let folderId: string | null = null;
  const files: UploadedCopy[] = [];

  for (const copy of input.copies) {
    const existing = await findExportedFile({
      accessToken: input.accessToken,
      driveId: input.driveId,
      envelopeId: input.envelopeId,
      fetchImpl: input.fetchImpl,
      sha256: copy.sha256,
    });

    if (existing) {
      files.push({ id: existing, kind: copy.kind, reused: true });
      continue;
    }

    folderId ??= await ensureFolderPath({
      accessToken: input.accessToken,
      driveId: input.driveId,
      fetchImpl: input.fetchImpl,
      folders: input.folders,
    });

    const uploaded = await uploadDriveFile<{ id: string }>({
      accessToken: input.accessToken,
      bytes: copy.bytes,
      contentType: "application/pdf",
      fetchImpl: input.fetchImpl,
      metadata: {
        appProperties: {
          [APP_PROPERTY_ENVELOPE]: input.envelopeId,
          [APP_PROPERTY_KIND]: copy.kind,
          [APP_PROPERTY_SHA256]: copy.sha256,
        },
        mimeType: "application/pdf",
        name: copy.fileName,
        parents: [folderId],
      },
      supportsAllDrives: true,
    });

    files.push({ id: uploaded.id, kind: copy.kind, reused: false });
  }

  return { files, folderId };
}

function describeProblem(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The label could not be applied.";

  return message.slice(0, MAX_PROBLEM_LENGTH);
}

/**
 * Puts the label on the file. Never throws: returns why it could not, or
 * which fields were left alone, or null when all went on.
 */
export async function labelExecutedCopy(input: {
  config: DriveLabelConfig;
  fetchImpl: FetchLike;
  fileId: string;
  getAccessToken: (request: GoogleAccessTokenRequest) => Promise<string>;
  values: LabelValues;
}): Promise<string | null> {
  const { config } = input;

  if (!config.labelId || Object.keys(config.fields).length === 0) {
    return null;
  }

  try {
    const label = await getDriveLabel(
      config.labelId,
      await input.getAccessToken({
        scopes: [GOOGLE_SCOPES.driveLabelsReadonly],
      }),
      input.fetchImpl,
    );
    const { fieldModifications, skipped } = buildLabelModification(
      label,
      config.fields,
      input.values,
    );
    const leftAlone = skipped.join("; ").slice(0, MAX_PROBLEM_LENGTH) || null;

    if (fieldModifications.length === 0) {
      return leftAlone ?? "The label had no field to fill in.";
    }

    await applyDriveLabel({
      accessToken: await input.getAccessToken({
        scopes: [GOOGLE_SCOPES.drive],
      }),
      fetchImpl: input.fetchImpl,
      fieldModifications,
      fileId: input.fileId,
      labelId: label.id || config.labelId,
    });

    return leftAlone;
  } catch (error) {
    return describeProblem(error);
  }
}

/** The address of a file in Drive, for the administrator's list. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/** The whole export, for WorkspaceFiles.exportExecutedCopies. */
export async function exportToSharedDrive(
  request: ExportRequest,
  deps: {
    fetchImpl: FetchLike;
    getAccessToken: (request: GoogleAccessTokenRequest) => Promise<string>;
    label: DriveLabelConfig;
  },
): Promise<ExportResult> {
  const uploaded = await uploadExecutedCopies({
    accessToken: await deps.getAccessToken({ scopes: [GOOGLE_SCOPES.drive] }),
    copies: request.copies,
    driveId: request.destination,
    envelopeId: request.envelopeId,
    fetchImpl: deps.fetchImpl,
    folders: request.folderPath,
  });
  const signed = uploaded.files.find((file) => file.kind === "signed");
  const metadataProblem = signed
    ? await labelExecutedCopy({
        config: deps.label,
        fetchImpl: deps.fetchImpl,
        fileId: signed.id,
        getAccessToken: deps.getAccessToken,
        values: request.metadata,
      })
    : null;

  return {
    files: uploaded.files.map((file) => ({
      id: file.id,
      kind: file.kind,
      url: driveFileUrl(file.id),
    })),
    metadataProblem,
  };
}
