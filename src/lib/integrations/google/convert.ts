import {
  FILE_TOO_LARGE_TO_CONVERT_MESSAGE,
  MAX_CONVERT_SOURCE_BYTES,
  MAX_UPLOAD_SIZE_BYTES,
} from "../../types/domain.ts";
import {
  DRIVE_API_BASE_URL,
  DriveApiError,
  driveFetch,
  DriveFileTooLargeError,
  driveJson,
  readLimitedBytes,
  uploadDriveFile,
  type FetchLike,
} from "./drive-api.ts";
import { GOOGLE_MEDIA_TIMEOUT_MS } from "./endpoints.ts";

// Turning a document into a PDF with Google Drive, for starting an envelope
// from something that is not a PDF yet: a Word file from Gmail, a Google
// Doc in Drive.
//
// A PDF is passed through as it is. Anything Google Docs, Sheets or Slides
// can open (Word, OpenDocument, RTF, Excel, PowerPoint, plain text) is
// uploaded to the person's Drive as a temporary Google file, converted on
// the way in, exported as a PDF, and the temporary file deleted again
// whatever happens. The person's own access token is used; drive.file is
// enough, because the app made the temporary file itself.
//
// Nothing here checks the PDF that comes out: createDraftFromDocument
// (import-draft.ts) does, the same way as for an upload.

export type ConvertedPdf = { bytes: Uint8Array; fileName: string };

export type ConvertOptions = { fetchImpl?: FetchLike };

/** Largest file sent to Drive for converting. Google's own limit is 50 MB. */
export { MAX_CONVERT_SOURCE_BYTES };

export const PDF_MIME_TYPE = "application/pdf";
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES_MIME_TYPE =
  "application/vnd.google-apps.presentation";
const GOOGLE_DRAWING_MIME_TYPE = "application/vnd.google-apps.drawing";
const GOOGLE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

/** Google files that export straight to PDF. */
export const GOOGLE_EXPORTABLE_MIME_TYPES: readonly string[] = [
  GOOGLE_DOC_MIME_TYPE,
  GOOGLE_SHEET_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE,
  GOOGLE_DRAWING_MIME_TYPE,
];

type ConvertibleType = { extensions: readonly string[]; target: string };

// What each kind of file is converted into, by MIME type and by extension:
// an attachment can arrive as application/octet-stream, so the name counts
// too.
const CONVERTIBLE_TYPES: Record<string, ConvertibleType> = {
  "application/msword": { extensions: ["doc"], target: GOOGLE_DOC_MIME_TYPE },
  "application/rtf": { extensions: ["rtf"], target: GOOGLE_DOC_MIME_TYPE },
  "application/vnd.ms-excel": {
    extensions: ["xls"],
    target: GOOGLE_SHEET_MIME_TYPE,
  },
  "application/vnd.ms-powerpoint": {
    extensions: ["ppt"],
    target: GOOGLE_SLIDES_MIME_TYPE,
  },
  "application/vnd.oasis.opendocument.presentation": {
    extensions: ["odp"],
    target: GOOGLE_SLIDES_MIME_TYPE,
  },
  "application/vnd.oasis.opendocument.spreadsheet": {
    extensions: ["ods"],
    target: GOOGLE_SHEET_MIME_TYPE,
  },
  "application/vnd.oasis.opendocument.text": {
    extensions: ["odt"],
    target: GOOGLE_DOC_MIME_TYPE,
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: ["pptx"],
    target: GOOGLE_SLIDES_MIME_TYPE,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: ["xlsx"],
    target: GOOGLE_SHEET_MIME_TYPE,
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: ["docx"],
    target: GOOGLE_DOC_MIME_TYPE,
  },
  "text/csv": { extensions: ["csv"], target: GOOGLE_SHEET_MIME_TYPE },
  "text/html": { extensions: ["htm", "html"], target: GOOGLE_DOC_MIME_TYPE },
  "text/plain": { extensions: ["txt"], target: GOOGLE_DOC_MIME_TYPE },
  "text/rtf": { extensions: ["rtf"], target: GOOGLE_DOC_MIME_TYPE },
};

/** Every MIME type that can be turned into a PDF, for pickers and Drive. */
export const CONVERTIBLE_MIME_TYPES: readonly string[] =
  Object.keys(CONVERTIBLE_TYPES);

export type DocumentConversionErrorCode =
  "drive_failed" | "too_large" | "unsupported_type";

const CONVERSION_MESSAGES: Record<DocumentConversionErrorCode, string> = {
  drive_failed:
    "Google Drive could not turn this file into a PDF. Try again, or save it as a PDF and upload that.",
  too_large: FILE_TOO_LARGE_TO_CONVERT_MESSAGE,
  unsupported_type:
    "This kind of file cannot be turned into a PDF. Use a PDF, a Word, OpenDocument or RTF document, or a Google Doc, Sheet or Slides file.",
};

export class DocumentConversionError extends Error {
  readonly code: DocumentConversionErrorCode;

  constructor(
    code: DocumentConversionErrorCode,
    options?: { cause?: unknown },
  ) {
    super(CONVERSION_MESSAGES[code], options);
    this.name = "DocumentConversionError";
    this.code = code;
  }
}

function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());

  return match?.[1]?.toLowerCase() ?? "";
}

function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isPdfInput(mimeType: string, fileName: string): boolean {
  return (
    normalizeMimeType(mimeType) === PDF_MIME_TYPE ||
    extensionOf(fileName) === "pdf"
  );
}

/**
 * The Google type a file is converted into and the type it is uploaded as,
 * or null when Drive cannot convert it.
 */
export function conversionTargetFor(
  mimeType: string,
  fileName: string,
): { sourceMimeType: string; target: string } | null {
  const normalized = normalizeMimeType(mimeType);
  const byMime = CONVERTIBLE_TYPES[normalized];

  if (byMime) {
    return { sourceMimeType: normalized, target: byMime.target };
  }

  const extension = extensionOf(fileName);

  for (const [type, entry] of Object.entries(CONVERTIBLE_TYPES)) {
    if (extension && entry.extensions.includes(extension)) {
      return { sourceMimeType: type, target: entry.target };
    }
  }

  return null;
}

/** The file's name with a .pdf ending, for the draft. */
export function pdfFileName(fileName: string): string {
  // Control characters and slashes become spaces.
  const cleaned = Array.from(fileName.trim(), (character) => {
    const code = character.charCodeAt(0);

    return code < 32 || code === 127 || character === "/" || character === "\\"
      ? " "
      : character;
  }).join("");
  const base = cleaned
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return `${(base || "document").slice(0, 200)}.pdf`;
}

async function exportPdf(
  fileId: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  const id = encodeURIComponent(fileId);
  let response: Response;

  try {
    response = await driveFetch(
      fetchImpl,
      accessToken,
      "Exporting from Drive",
      `${DRIVE_API_BASE_URL}/files/${id}/export?mimeType=${encodeURIComponent(PDF_MIME_TYPE)}`,
      {},
      GOOGLE_MEDIA_TIMEOUT_MS,
    );
  } catch (error) {
    // files.export stops at 10 MB of output. A larger file can still be
    // read through its export link.
    if (
      !(error instanceof DriveApiError) ||
      error.reason !== "exportSizeLimitExceeded"
    ) {
      throw error;
    }

    const file = await driveJson<{ exportLinks?: Record<string, string> }>(
      fetchImpl,
      accessToken,
      "Reading the export link",
      `${DRIVE_API_BASE_URL}/files/${id}?fields=exportLinks&supportsAllDrives=true`,
    );
    const link = file.exportLinks?.[PDF_MIME_TYPE];

    if (!link || !link.startsWith("https://docs.google.com/")) {
      throw error;
    }

    response = await driveFetch(
      fetchImpl,
      accessToken,
      "Exporting from Drive",
      link,
      {},
      GOOGLE_MEDIA_TIMEOUT_MS,
    );
  }

  return readLimitedBytes(response, MAX_UPLOAD_SIZE_BYTES, "The exported PDF");
}

function toConversionError(error: unknown): unknown {
  if (error instanceof DocumentConversionError) {
    return error;
  }

  if (error instanceof DriveFileTooLargeError) {
    return new DocumentConversionError("too_large", { cause: error });
  }

  if (error instanceof DriveApiError) {
    return new DocumentConversionError("drive_failed", { cause: error });
  }

  return error;
}

/**
 * A PDF of the document. A PDF comes back as it is; anything Drive can
 * open is converted through a temporary Google file in the person's Drive,
 * deleted again afterwards.
 */
export async function convertToPdf(
  input: {
    bytes: Uint8Array;
    mimeType: string;
    fileName: string;
    accessToken: string;
  },
  { fetchImpl = fetch }: ConvertOptions = {},
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const fileName = pdfFileName(input.fileName);

  if (isPdfInput(input.mimeType, input.fileName)) {
    return { bytes: input.bytes, fileName };
  }

  const conversion = conversionTargetFor(input.mimeType, input.fileName);

  if (!conversion) {
    throw new DocumentConversionError("unsupported_type");
  }

  if (input.bytes.byteLength > MAX_CONVERT_SOURCE_BYTES) {
    throw new DocumentConversionError("too_large");
  }

  let temporaryId: string | null = null;

  try {
    const uploaded = await uploadDriveFile<{ id: string }>({
      accessToken: input.accessToken,
      bytes: input.bytes,
      contentType: conversion.sourceMimeType,
      fetchImpl,
      metadata: {
        appProperties: { signudocTemporary: "1" },
        mimeType: conversion.target,
        name: fileName.replace(/\.pdf$/, ""),
      },
    });

    temporaryId = uploaded.id;

    return {
      bytes: await exportPdf(uploaded.id, input.accessToken, fetchImpl),
      fileName,
    };
  } catch (error) {
    throw toConversionError(error);
  } finally {
    if (temporaryId) {
      await driveFetch(
        fetchImpl,
        input.accessToken,
        "Deleting the temporary file",
        `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(temporaryId)}`,
        { method: "DELETE" },
      ).catch((error: unknown) => {
        console.warn(
          "[drive] A temporary file made for a conversion could not be deleted:",
          error instanceof Error ? error.message : error,
        );
      });
    }
  }
}

type DriveFile = {
  id: string;
  mimeType?: string;
  name?: string;
  shortcutDetails?: { targetId?: string };
  size?: string;
};

/**
 * A PDF of a file in Drive: Google Docs, Sheets, Slides and drawings are
 * exported; a PDF is downloaded; Word and the rest are downloaded and
 * converted (convertToPdf). A shortcut is followed once.
 */
export async function exportGoogleFileToPdf(
  input: { fileId: string; accessToken: string },
  options: ConvertOptions = {},
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    let file = await readFile(input.fileId, input.accessToken, fetchImpl);

    if (file.mimeType === GOOGLE_SHORTCUT_MIME_TYPE) {
      const targetId = file.shortcutDetails?.targetId;

      if (!targetId) {
        throw new DocumentConversionError("unsupported_type");
      }

      file = await readFile(targetId, input.accessToken, fetchImpl);
    }

    const mimeType = file.mimeType ?? "";
    const name = file.name ?? "document";

    if (GOOGLE_EXPORTABLE_MIME_TYPES.includes(mimeType)) {
      return {
        bytes: await exportPdf(file.id, input.accessToken, fetchImpl),
        fileName: pdfFileName(name),
      };
    }

    if (mimeType.startsWith("application/vnd.google-apps.")) {
      throw new DocumentConversionError("unsupported_type");
    }

    const pdf = isPdfInput(mimeType, name);

    if (!pdf && !conversionTargetFor(mimeType, name)) {
      throw new DocumentConversionError("unsupported_type");
    }

    const limit = pdf ? MAX_UPLOAD_SIZE_BYTES : MAX_CONVERT_SOURCE_BYTES;

    if (Number(file.size ?? "0") > limit) {
      throw new DocumentConversionError("too_large");
    }

    const response = await driveFetch(
      fetchImpl,
      input.accessToken,
      "Downloading from Drive",
      `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      {},
      GOOGLE_MEDIA_TIMEOUT_MS,
    );
    const bytes = await readLimitedBytes(response, limit, "The Drive file");

    return await convertToPdf(
      { accessToken: input.accessToken, bytes, fileName: name, mimeType },
      { fetchImpl },
    );
  } catch (error) {
    throw toConversionError(error);
  }
}

async function readFile(
  fileId: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<DriveFile> {
  const query = new URLSearchParams({
    fields: "id,name,mimeType,size,shortcutDetails(targetId)",
    supportsAllDrives: "true",
  });

  return driveJson<DriveFile>(
    fetchImpl,
    accessToken,
    "Reading the Drive file",
    `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}?${query.toString()}`,
  );
}
