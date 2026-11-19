import {
  DocumentConversionError,
  exportGoogleFileToPdf,
  PICKER_MIME_TYPES,
  type ConvertedPdf,
} from "../drive/convert.ts";
import { DriveApiError, type FetchLike } from "../drive/drive-api.ts";

// The Drive side of the add-on: which selected files can be sent for
// signature, and reading one as a PDF as the person using the add-on.
//
// The add-on asks only for drive.file, so it can open a file once the user
// has given it that file. Drive says whether it has, per selected item, as
// addonHasFileScopePermission; when it has not, the card asks for it with
// the requestFileScope host action
// (https://developers.google.com/workspace/add-ons/drive/drive-actions).
// Reading and converting is the same as starting from a file picked in the
// app (drive/convert.ts): a Google Doc, Sheet or Slides file is exported,
// a PDF downloaded, and a Word file or the like converted through Drive.

/** Whether a Drive file of this type can be sent for signature. */
export function isSendableDriveFile(mimeType: string): boolean {
  return PICKER_MIME_TYPES.includes(mimeType.trim().toLowerCase());
}

/** The selected file as a PDF, read with the add-on's token for the user. */
export function readDriveFileAsPdf(
  fileId: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<ConvertedPdf> {
  return exportGoogleFileToPdf({ accessToken, fileId }, { fetchImpl });
}

function driveStatus(error: unknown): number | null {
  const drive =
    error instanceof DriveApiError
      ? error
      : error instanceof DocumentConversionError &&
          error.cause instanceof DriveApiError
        ? error.cause
        : null;

  return drive?.status ?? null;
}

/**
 * Whether Drive refused because the add-on has not been given the file
 * (drive.file): it then answers 403 or 404, as for a file that is not
 * there.
 */
export function needsFileAccess(error: unknown): boolean {
  const status = driveStatus(error);

  return status === 403 || status === 404;
}
