import { exportGoogleFileToPdf } from "./convert.ts";
import { getUserDriveAccessToken } from "./drive-tokens.ts";
import { createDraftFromDocument, draftPreparePath } from "./import-draft.ts";

// A draft from a file in someone's Google Drive, picked with the Picker or
// opened with "Open with": their own drive.file token reads it (Drive gave
// the app access to that one file when they picked or opened it), it is
// turned into a PDF if it is not one, and the draft is made the same way as
// an upload.

/** Drive file IDs are letters, digits, dashes and underscores. */
export function isDriveFileId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

export type DriveOpenState = {
  action: "create" | "open";
  /** The first file opened; Drive can send several, one draft is made. */
  fileId: string | null;
  /** The Google account that opened it in Drive. */
  googleUserId: string | null;
};

/**
 * Drive's "Open with" request, from the state parameter Drive adds to the
 * open URL: {"ids": [...], "action": "open", "userId": "..."}, or
 * "exportIds" instead of "ids" for a Google Doc opened with importing on.
 * https://developers.google.com/workspace/drive/api/guides/integrate-open
 */
export function parseDriveOpenState(raw: string | null): DriveOpenState | null {
  if (!raw || raw.length > 10_000) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const state = parsed as {
    action?: unknown;
    exportIds?: unknown;
    ids?: unknown;
    userId?: unknown;
  };
  const action =
    state.action === "open"
      ? "open"
      : state.action === "create"
        ? "create"
        : null;

  if (!action) {
    return null;
  }

  const ids = Array.isArray(state.ids)
    ? state.ids
    : Array.isArray(state.exportIds)
      ? state.exportIds
      : [];
  const fileId = ids.find(isDriveFileId) ?? null;

  if (action === "open" && !fileId) {
    return null;
  }

  return {
    action,
    fileId,
    googleUserId:
      typeof state.userId === "string" &&
      /^[0-9A-Za-z_-]{1,64}$/.test(state.userId)
        ? state.userId
        : null,
  };
}

export async function importDriveFileAsDraft(
  userId: string,
  fileId: string,
): Promise<{ envelopeId: string; redirectPath: string }> {
  const accessToken = await getUserDriveAccessToken(userId);
  const pdf = await exportGoogleFileToPdf({ accessToken, fileId });
  const { envelopeId } = await createDraftFromDocument({
    bytes: pdf.bytes,
    fileName: pdf.fileName,
    source: { kind: "drive", ref: fileId },
    userId,
  });

  return { envelopeId, redirectPath: draftPreparePath(envelopeId) };
}
