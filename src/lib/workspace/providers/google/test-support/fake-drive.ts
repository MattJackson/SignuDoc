import { createHash } from "node:crypto";

import {
  newId,
  page,
  readJsonBody,
  requireScope,
  sendGoogleError,
  sendJson,
  sendMasked,
  storeDrive,
  type FakeAccessToken,
  type FakeRequest,
  type StoredFile,
} from "./fake-state.ts";

// The part of the Drive API v3 a document integration needs: uploads
// (multipart, media and resumable) with conversion into Google Docs,
// Sheets and Slides, metadata, download, export, copy, the files.list
// query language for parents, appProperties and the like, shared drives
// and permissions. Like Drive, a response carries only id, name and
// mimeType unless ?fields= asks for more, files in a shared drive are only
// found with supportsAllDrives=true, and a Google Docs file cannot be
// downloaded, only exported. An export to PDF is the uploaded PDF when a
// PDF was converted, and otherwise a one-page PDF naming the file.
// https://developers.google.com/workspace/drive/api/reference/rest/v3

export const GOOGLE_APPS = {
  document: "application/vnd.google-apps.document",
  folder: "application/vnd.google-apps.folder",
  presentation: "application/vnd.google-apps.presentation",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
} as const;

export const ROOT_FOLDER_ID = "0AFakeMyDriveRoot";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// What Drive converts into each Google type on upload.
const IMPORTS: Record<string, string[]> = {
  [GOOGLE_APPS.document]: [
    DOCX,
    "application/msword",
    "application/vnd.oasis.opendocument.text",
    "application/rtf",
    "application/pdf",
    "text/html",
    "text/plain",
  ],
  [GOOGLE_APPS.presentation]: [
    PPTX,
    "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument.presentation",
  ],
  [GOOGLE_APPS.spreadsheet]: [
    XLSX,
    "application/vnd.ms-excel",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
    "text/tab-separated-values",
  ],
};

// What each Google type exports to.
const EXPORTS: Record<string, string[]> = {
  [GOOGLE_APPS.document]: [
    "application/pdf",
    DOCX,
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
    "text/html",
    "text/plain",
  ],
  [GOOGLE_APPS.presentation]: ["application/pdf", PPTX, "text/plain"],
  [GOOGLE_APPS.spreadsheet]: ["application/pdf", XLSX, "text/csv"],
};

const DEFAULT_FILE_FIELDS = "kind,id,name,mimeType";
const DEFAULT_LIST_FIELDS = `kind,incompleteSearch,nextPageToken,files(${DEFAULT_FILE_FIELDS})`;

function isGoogleType(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}

/** A small valid one-page PDF with these lines of text. */
export function minimalPdf(lines: string[]): Buffer {
  const escape = (text: string) =>
    text
      .replace(/[\\()]/g, (character) => `\\${character}`)
      .replace(/[^\x20-\x7e]/g, "?");
  const text = lines
    .map(
      (line, index) =>
        `BT /F1 14 Tf 72 ${String(720 - index * 22)} Td (${escape(line)}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(text.length)} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (const [index, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }

  const xref = out.length;

  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

type MultipartPart = { content: Buffer; headers: Record<string, string> };

/** Splits a multipart/related body (the metadata, then the content). */
export function parseMultipart(
  body: Buffer,
  contentType: string,
): MultipartPart[] | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);

  if (!match) {
    return null;
  }

  const boundary = Buffer.from(`--${match[1] ?? match[2] ?? ""}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(boundary);

  while (start !== -1) {
    const after = start + boundary.length;

    if (body.subarray(after, after + 2).toString() === "--") {
      break;
    }

    const next = body.indexOf(boundary, after);

    if (next === -1) {
      break;
    }

    let part = body.subarray(after, next);

    if (part.subarray(0, 2).toString() === "\r\n") {
      part = part.subarray(2);
    }

    if (part.subarray(part.length - 2).toString() === "\r\n") {
      part = part.subarray(0, part.length - 2);
    }

    const split = part.indexOf("\r\n\r\n");
    const headerText =
      split === -1 ? "" : part.subarray(0, split).toString("utf8");
    let content = split === -1 ? part : part.subarray(split + 4);
    const headers: Record<string, string> = {};

    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");

      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
    }

    if (headers["content-transfer-encoding"]?.toLowerCase() === "base64") {
      content = Buffer.from(content.toString("ascii"), "base64");
    }

    parts.push({ content, headers });
    start = next;
  }

  return parts;
}

export class DriveQueryError extends Error {}

const STRING = String.raw`'((?:[^'\\]|\\.)*)'`;

function unescapeString(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/** Splits on a keyword (and, or) outside quotes and braces. */
function splitTopLevel(query: string, keyword: "and" | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!;

    if (inString) {
      current += character;

      if (character === "\\") {
        current += query[index + 1] ?? "";
        index += 1;
      } else if (character === "'") {
        inString = false;
      }

      continue;
    }

    if (character === "'") {
      inString = true;
    } else if (character === "{" || character === "(") {
      depth += 1;
    } else if (character === "}" || character === ")") {
      depth -= 1;
    }

    const rest = query.slice(index);
    const word = new RegExp(`^\\s+${keyword}\\s+`, "i").exec(rest);

    if (depth === 0 && word) {
      parts.push(current);
      current = "";
      index += word[0].length - 1;
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts.map((part) => part.trim()).filter(Boolean);
}

type FileTest = (file: StoredFile) => boolean;

function compileClause(clause: string): FileTest {
  let match = new RegExp(`^not\\s+(.+)$`, "i").exec(clause);

  if (match) {
    const inner = compileClause(match[1]!.trim());

    return (file) => !inner(file);
  }

  if (/^\(.*\)$/.test(clause)) {
    return compileDriveQuery(clause.slice(1, -1));
  }

  match = new RegExp(
    `^(appProperties|properties)\\s+has\\s*\\{\\s*key\\s*=\\s*${STRING}\\s+and\\s+value\\s*=\\s*${STRING}\\s*\\}$`,
  ).exec(clause);

  if (match) {
    const field = match[1] as "appProperties" | "properties";
    const key = unescapeString(match[2]!);
    const value = unescapeString(match[3]!);

    return (file) => file[field][key] === value;
  }

  match = new RegExp(
    `^${STRING}\\s+in\\s+(parents|owners|writers|readers)$`,
  ).exec(clause);

  if (match) {
    const value = unescapeString(match[1]!);

    if (match[2] === "parents") {
      const parent = value === "root" ? ROOT_FOLDER_ID : value;

      return (file) => file.parents.includes(parent);
    }

    const owners = match[2] === "owners";

    return (file) =>
      owners
        ? file.ownerEmail === value.toLowerCase()
        : file.ownerEmail === value.toLowerCase() ||
          file.permissions.some(
            (permission) => permission.emailAddress === value.toLowerCase(),
          );
  }

  match = /^trashed\s*(=|!=)\s*(true|false)$/i.exec(clause);

  if (match) {
    const wanted = (match[2]!.toLowerCase() === "true") === (match[1] === "=");

    return (file) => file.trashed === wanted;
  }

  match = new RegExp(`^(mimeType|name)\\s*(=|!=)\\s*${STRING}$`).exec(clause);

  if (match) {
    const field = match[1] as "mimeType" | "name";
    const value = unescapeString(match[3]!);
    const equal = match[2] === "=";

    return (file) => (file[field] === value) === equal;
  }

  match = new RegExp(`^(name|fullText)\\s+contains\\s+${STRING}$`).exec(clause);

  if (match) {
    const value = unescapeString(match[2]!).toLowerCase();
    const nameOnly = match[1] === "name";

    return (file) =>
      nameOnly
        ? file.name.toLowerCase().includes(value)
        : file.name.toLowerCase().includes(value) ||
          file.content.toString("utf8").toLowerCase().includes(value);
  }

  match = new RegExp(
    `^(modifiedTime|createdTime)\\s*(<=|>=|!=|<|>|=)\\s*${STRING}$`,
  ).exec(clause);

  if (match) {
    const field = match[1] as "createdTime" | "modifiedTime";
    const operator = match[2]!;
    const value = new Date(unescapeString(match[3]!)).getTime();

    return (file) => {
      const time = new Date(file[field]).getTime();

      switch (operator) {
        case "<":
          return time < value;
        case "<=":
          return time <= value;
        case ">":
          return time > value;
        case ">=":
          return time >= value;
        case "!=":
          return time !== value;
        default:
          return time === value;
      }
    };
  }

  throw new DriveQueryError(
    `Invalid Value: the fake Drive does not understand "${clause}".`,
  );
}

/**
 * A matcher for a files.list q, with and, or, not and parentheses.
 * https://developers.google.com/workspace/drive/api/guides/ref-search-terms
 */
export function compileDriveQuery(query: string): FileTest {
  const alternatives = splitTopLevel(query, "or").map((alternative) => {
    const clauses = splitTopLevel(alternative, "and").map(compileClause);

    return (file: StoredFile) => clauses.every((check) => check(file));
  });

  if (alternatives.length === 0) {
    return () => true;
  }

  return (file) => alternatives.some((check) => check(file));
}

function webViewLink(file: StoredFile): string {
  switch (file.mimeType) {
    case GOOGLE_APPS.document:
      return `https://docs.google.com/document/d/${file.id}/edit`;
    case GOOGLE_APPS.spreadsheet:
      return `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
    case GOOGLE_APPS.presentation:
      return `https://docs.google.com/presentation/d/${file.id}/edit`;
    case GOOGLE_APPS.folder:
      return `https://drive.google.com/drive/folders/${file.id}`;
    default:
      return `https://drive.google.com/file/d/${file.id}/view`;
  }
}

export function fileResource(file: StoredFile) {
  const binary = !isGoogleType(file.mimeType);

  return {
    appProperties: file.appProperties,
    capabilities: {
      canDownload: true,
      canEdit: true,
      canShare: true,
    },
    createdTime: file.createdTime,
    ...(file.description !== null ? { description: file.description } : {}),
    ...(file.driveId ? { driveId: file.driveId } : {}),
    ...(isGoogleType(file.mimeType) && EXPORTS[file.mimeType]
      ? {
          exportLinks: Object.fromEntries(
            EXPORTS[file.mimeType]!.map((type) => [
              type,
              `https://docs.google.com/feeds/download/export?id=${file.id}&exportFormat=${encodeURIComponent(type)}`,
            ]),
          ),
        }
      : {}),
    id: file.id,
    kind: "drive#file",
    ...(binary
      ? {
          md5Checksum: createHash("md5").update(file.content).digest("hex"),
          size: String(file.content.length),
        }
      : {}),
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    name: file.name,
    ...(file.ownerEmail
      ? {
          owners: [
            {
              emailAddress: file.ownerEmail,
              kind: "drive#user",
              me: true,
            },
          ],
        }
      : {}),
    parents: file.parents,
    permissions: file.permissions.map((permission) => ({
      kind: "drive#permission",
      ...permission,
    })),
    properties: file.properties,
    trashed: file.trashed,
    version: String(file.version),
    webViewLink: webViewLink(file),
  };
}

function allDrives(context: FakeRequest): boolean {
  return context.query.get("supportsAllDrives") === "true";
}

function notFound(context: FakeRequest, id: string) {
  sendGoogleError(context.response, 404, "notFound", `File not found: ${id}.`);
}

/**
 * The file, or a 404 like Drive's when there is none, or when it is in a
 * shared drive and the request did not say supportsAllDrives=true.
 */
function getFile(context: FakeRequest, id: string): StoredFile | null {
  const file = context.state.files.get(id);

  if (!file || (file.driveId && !allDrives(context))) {
    notFound(context, id);
    return null;
  }

  return file;
}

function stringRecord(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const result: Record<string, string | null> = {};

  for (const [key, item] of Object.entries(value)) {
    result[key] = item === null ? null : String(item);
  }

  return result;
}

function mergeProperties(
  current: Record<string, string>,
  changes: Record<string, string | null> | null,
): Record<string, string> {
  const merged = { ...current };

  for (const [key, value] of Object.entries(changes ?? {})) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/** Where a new file goes, and the shared drive that makes it part of. */
function resolveParents(
  context: FakeRequest,
  requested: unknown,
): { driveId: string | null; parents: string[] } | null {
  const ids = Array.isArray(requested)
    ? requested.map(String)
    : [ROOT_FOLDER_ID];
  let driveId: string | null = null;
  const parents: string[] = [];

  for (const raw of ids.length > 0 ? ids : [ROOT_FOLDER_ID]) {
    const id = raw === "root" ? ROOT_FOLDER_ID : raw;
    const drive = context.state.drives.get(id);
    const folder = context.state.files.get(id);

    if (id === ROOT_FOLDER_ID) {
      parents.push(id);
      continue;
    }

    if (drive || folder?.driveId) {
      if (!allDrives(context)) {
        notFound(context, raw);
        return null;
      }

      driveId = drive ? drive.id : (folder?.driveId ?? null);
      parents.push(id);
      continue;
    }

    if (!folder || folder.mimeType !== GOOGLE_APPS.folder) {
      notFound(context, raw);
      return null;
    }

    parents.push(id);
  }

  return { driveId, parents };
}

function creatorOf(token: FakeAccessToken): string | null {
  return token.user ?? token.serviceAccount;
}

/** Makes a file from metadata and content, converting when asked to. */
function createFile(
  context: FakeRequest,
  token: FakeAccessToken,
  metadata: Record<string, unknown>,
  content: Buffer,
  contentType: string | null,
): StoredFile | null {
  const location = resolveParents(context, metadata.parents);

  if (!location) {
    return null;
  }

  const requestedType =
    typeof metadata.mimeType === "string" ? metadata.mimeType : null;
  const mediaType = contentType?.split(";")[0]?.trim() || null;
  let mimeType = requestedType ?? mediaType ?? "application/octet-stream";
  let sourceMimeType: string | null = null;

  if (requestedType && isGoogleType(requestedType) && content.length > 0) {
    const accepted = IMPORTS[requestedType] ?? [];

    if (!mediaType || !accepted.includes(mediaType)) {
      sendGoogleError(
        context.response,
        400,
        "badRequest",
        `The fake Drive cannot convert ${mediaType ?? "this content"} into ${requestedType}.`,
      );
      return null;
    }

    mimeType = requestedType;
    sourceMimeType = mediaType;
  }

  const now = new Date().toISOString();
  const file: StoredFile = {
    appProperties: mergeProperties({}, stringRecord(metadata.appProperties)),
    content,
    createdTime: now,
    description:
      typeof metadata.description === "string" ? metadata.description : null,
    driveId: location.driveId,
    id: newId(context.state, "1Fake"),
    mimeType,
    modifiedTime: now,
    name: typeof metadata.name === "string" ? metadata.name : "Untitled",
    ownerEmail: location.driveId ? null : creatorOf(token),
    parents: location.parents,
    permissions: [],
    properties: mergeProperties({}, stringRecord(metadata.properties)),
    sourceMimeType,
    trashed: false,
    version: 1,
  };

  context.state.files.set(file.id, file);

  return file;
}

function updateFile(
  context: FakeRequest,
  file: StoredFile,
  metadata: Record<string, unknown>,
  content: Buffer | null,
) {
  if (typeof metadata.name === "string") {
    file.name = metadata.name;
  }

  if (typeof metadata.description === "string") {
    file.description = metadata.description;
  }

  if (typeof metadata.trashed === "boolean") {
    file.trashed = metadata.trashed;
  }

  file.appProperties = mergeProperties(
    file.appProperties,
    stringRecord(metadata.appProperties),
  );
  file.properties = mergeProperties(
    file.properties,
    stringRecord(metadata.properties),
  );

  const add = context.query.get("addParents")?.split(",").filter(Boolean);
  const remove = context.query.get("removeParents")?.split(",").filter(Boolean);

  if (remove) {
    file.parents = file.parents.filter((parent) => !remove.includes(parent));
  }

  if (add) {
    for (const parent of add) {
      if (!file.parents.includes(parent)) {
        file.parents.push(parent === "root" ? ROOT_FOLDER_ID : parent);
      }
    }
  }

  if (content) {
    file.content = content;
  }

  file.version += 1;
  file.modifiedTime = new Date().toISOString();
}

function handleUpload(
  context: FakeRequest,
  token: FakeAccessToken,
  fileId: string | null,
) {
  const { body, query, request, response, state } = context;
  const uploadId = query.get("upload_id");

  // The second step of a resumable upload: the content.
  if (uploadId) {
    const session = state.uploads.get(uploadId);

    if (!session) {
      sendGoogleError(response, 404, "notFound", "No such upload session.");
      return;
    }

    state.uploads.delete(uploadId);

    const sessionContext = { ...context, query: session.query };

    if (session.fileId) {
      const file = getFile(sessionContext, session.fileId);

      if (file) {
        updateFile(sessionContext, file, session.metadata, body);
        sendMasked(sessionContext, fileResource(file), DEFAULT_FILE_FIELDS);
      }

      return;
    }

    const file = createFile(
      sessionContext,
      token,
      session.metadata,
      body,
      session.contentType ?? request.headers["content-type"] ?? null,
    );

    if (file) {
      sendMasked(sessionContext, fileResource(file), DEFAULT_FILE_FIELDS);
    }

    return;
  }

  const uploadType = query.get("uploadType");
  const contentType = request.headers["content-type"] ?? "";
  let metadata: Record<string, unknown> = {};
  let content: Buffer = Buffer.alloc(0);
  let mediaType: string | null = null;

  if (uploadType === "multipart") {
    const parts = parseMultipart(body, contentType);
    const metadataPart = parts?.[0];
    const mediaPart = parts?.[1];

    if (!metadataPart || !mediaPart) {
      sendGoogleError(
        response,
        400,
        "badContent",
        "A multipart upload needs the metadata and the content.",
      );
      return;
    }

    metadata = readJsonBody(metadataPart.content) ?? {};
    content = mediaPart.content;
    mediaType = mediaPart.headers["content-type"] ?? null;
  } else if (uploadType === "media") {
    content = body;
    mediaType = contentType || null;
  } else if (uploadType === "resumable") {
    const id = newId(state, "upload");
    const header = request.headers["x-upload-content-type"];

    state.uploads.set(id, {
      contentType: typeof header === "string" ? header : null,
      fileId,
      metadata: readJsonBody(body) ?? {},
      query,
    });

    const location = new URL(
      `${context.baseUrl}/upload/drive/v3/files${fileId ? `/${fileId}` : ""}`,
    );

    location.searchParams.set("uploadType", "resumable");
    location.searchParams.set("upload_id", id);
    response
      .writeHead(200, {
        location: location.toString(),
        "x-guploader-uploadid": id,
      })
      .end();
    return;
  } else {
    sendGoogleError(
      response,
      400,
      "invalid",
      `Invalid value for uploadType: ${uploadType ?? "(none)"}`,
    );
    return;
  }

  if (fileId) {
    const file = getFile(context, fileId);

    if (file) {
      updateFile(context, file, metadata, content);
      sendMasked(context, fileResource(file), DEFAULT_FILE_FIELDS);
    }

    return;
  }

  const file = createFile(context, token, metadata, content, mediaType);

  if (file) {
    sendMasked(context, fileResource(file), DEFAULT_FILE_FIELDS);
  }
}

function sortFiles(files: StoredFile[], orderBy: string | null) {
  if (!orderBy) {
    return files;
  }

  const keys = orderBy.split(",").map((item) => {
    const [field = "", direction] = item.trim().split(/\s+/);

    return { descending: direction?.toLowerCase() === "desc", field };
  });

  return [...files].sort((a, b) => {
    for (const { descending, field } of keys) {
      const left =
        field === "name" || field === "name_natural"
          ? a.name.toLowerCase()
          : field === "createdTime"
            ? a.createdTime
            : a.modifiedTime;
      const right =
        field === "name" || field === "name_natural"
          ? b.name.toLowerCase()
          : field === "createdTime"
            ? b.createdTime
            : b.modifiedTime;
      const order = left.localeCompare(right);

      if (order !== 0) {
        return descending ? -order : order;
      }
    }

    return 0;
  });
}

function listFiles(context: FakeRequest) {
  const { query, state } = context;
  let matcher: FileTest;

  try {
    matcher = compileDriveQuery(query.get("q") ?? "");
  } catch (error) {
    sendGoogleError(
      context.response,
      400,
      "invalid",
      error instanceof Error ? error.message : "Invalid Value",
    );
    return;
  }

  const driveId = query.get("driveId");
  const everywhere = query.get("includeItemsFromAllDrives") === "true";

  if (
    (driveId || query.get("corpora") === "allDrives") &&
    (!everywhere || !allDrives(context))
  ) {
    sendGoogleError(
      context.response,
      403,
      "teamDrivesParameterRequired",
      "The includeItemsFromAllDrives and supportsAllDrives parameters must be set to true.",
    );
    return;
  }

  const files = sortFiles(
    Array.from(state.files.values()).filter(
      (file) =>
        (driveId
          ? file.driveId === driveId
          : everywhere || file.driveId === null) && matcher(file),
    ),
    query.get("orderBy"),
  );
  const result = page(files, query, "pageSize", 100, 1000);

  sendMasked(
    context,
    {
      files: result.items.map(fileResource),
      incompleteSearch: false,
      kind: "drive#fileList",
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    },
    DEFAULT_LIST_FIELDS,
  );
}

function exportFile(context: FakeRequest, file: StoredFile) {
  const wanted = context.query.get("mimeType") ?? "";

  if (!isGoogleType(file.mimeType)) {
    sendGoogleError(
      context.response,
      403,
      "fileNotExportable",
      "Export only supports Docs Editors files.",
    );
    return;
  }

  if (!(EXPORTS[file.mimeType] ?? []).includes(wanted)) {
    sendGoogleError(
      context.response,
      400,
      "badRequest",
      `The requested conversion is not supported: ${wanted || "(none)"}.`,
    );
    return;
  }

  let content: Buffer;

  if (file.sourceMimeType === wanted) {
    content = file.content;
  } else if (wanted === "application/pdf") {
    content = minimalPdf([file.name, "Exported by the fake Google Drive."]);
  } else if (wanted === "text/plain" || wanted === "text/csv") {
    content = file.sourceMimeType?.startsWith("text/")
      ? file.content
      : Buffer.from(file.name, "utf8");
  } else {
    content = file.content;
  }

  context.response.writeHead(200, { "content-type": wanted }).end(content);
}

function handleFile(
  context: FakeRequest,
  token: FakeAccessToken,
  id: string,
  rest: string[],
) {
  const { method, response, state } = context;
  const file = getFile(context, id);

  if (!file) {
    return;
  }

  if (rest.length === 0) {
    if (method === "GET") {
      if (context.query.get("alt") === "media") {
        if (isGoogleType(file.mimeType)) {
          sendGoogleError(
            response,
            403,
            "fileNotDownloadable",
            "Only files with binary content can be downloaded. Use Export with Docs Editors files.",
          );
          return;
        }

        response
          .writeHead(200, { "content-type": file.mimeType })
          .end(file.content);
        return;
      }

      sendMasked(context, fileResource(file), DEFAULT_FILE_FIELDS);
      return;
    }

    if (method === "PATCH") {
      updateFile(context, file, readJsonBody(context.body) ?? {}, null);
      sendMasked(context, fileResource(file), DEFAULT_FILE_FIELDS);
      return;
    }

    if (method === "DELETE") {
      state.files.delete(file.id);
      response.writeHead(204).end();
      return;
    }
  }

  if (rest[0] === "export" && method === "GET") {
    exportFile(context, file);
    return;
  }

  if (rest[0] === "copy" && method === "POST") {
    const metadata = readJsonBody(context.body) ?? {};
    const copy = createFile(
      context,
      token,
      {
        ...metadata,
        name:
          typeof metadata.name === "string"
            ? metadata.name
            : `Copy of ${file.name}`,
        parents: metadata.parents ?? file.parents,
      },
      file.content,
      null,
    );

    if (copy) {
      copy.mimeType = file.mimeType;
      copy.sourceMimeType = file.sourceMimeType;
      copy.appProperties = mergeProperties(
        { ...file.appProperties },
        stringRecord(metadata.appProperties),
      );
      sendMasked(context, fileResource(copy), DEFAULT_FILE_FIELDS);
    }

    return;
  }

  if (rest[0] === "permissions") {
    if (rest.length === 1 && method === "GET") {
      sendMasked(
        context,
        {
          kind: "drive#permissionList",
          permissions: file.permissions.map((permission) => ({
            kind: "drive#permission",
            ...permission,
          })),
        },
        null,
      );
      return;
    }

    if (rest.length === 1 && method === "POST") {
      const input = readJsonBody(context.body) ?? {};
      const permission = {
        ...(typeof input.domain === "string" ? { domain: input.domain } : {}),
        ...(typeof input.emailAddress === "string"
          ? { emailAddress: input.emailAddress.toLowerCase() }
          : {}),
        id: newId(state, "perm"),
        role: typeof input.role === "string" ? input.role : "reader",
        type: typeof input.type === "string" ? input.type : "user",
      };

      file.permissions.push(permission);
      sendMasked(
        context,
        { kind: "drive#permission", ...permission },
        "kind,id,type,role",
      );
      return;
    }

    if (rest.length === 2 && method === "DELETE") {
      file.permissions = file.permissions.filter(
        (permission) => permission.id !== rest[1],
      );
      response.writeHead(204).end();
      return;
    }
  }

  sendGoogleError(
    response,
    404,
    "notFound",
    `The fake Drive has no ${method} ${context.path}.`,
  );
}

function handleDrives(context: FakeRequest, rest: string[]) {
  const { method, state } = context;
  const resource = (drive: {
    createdTime: string;
    id: string;
    name: string;
  }) => ({
    createdTime: drive.createdTime,
    id: drive.id,
    kind: "drive#drive",
    name: drive.name,
  });

  if (rest.length === 0 && method === "GET") {
    const drives = Array.from(state.drives.values()).filter((drive) => {
      const q = context.query.get("q");
      const match = q
        ? new RegExp(`^name\\s*contains\\s*${STRING}$`).exec(q)
        : null;

      return !match || drive.name.includes(unescapeString(match[1]!));
    });
    const result = page(drives, context.query, "pageSize", 10, 100);

    sendMasked(
      context,
      {
        drives: result.items.map(resource),
        kind: "drive#driveList",
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      },
      null,
    );
    return;
  }

  if (rest.length === 0 && method === "POST") {
    const input = readJsonBody(context.body) ?? {};
    const drive = storeDrive(state, {
      name: typeof input.name === "string" ? input.name : "Untitled drive",
    });

    sendMasked(context, resource(drive), null);
    return;
  }

  const drive = rest[0] ? state.drives.get(rest[0]) : undefined;

  if (drive && rest.length === 1 && method === "GET") {
    sendMasked(context, resource(drive), null);
    return;
  }

  sendGoogleError(
    context.response,
    404,
    "notFound",
    `Shared drive not found: ${rest[0] ?? ""}`,
  );
}

const DRIVE_AUTH = "https://www.googleapis.com/auth/drive";
// Drive honours these scopes for reading, and the first two for changing
// anything. The labels and add-on scopes that start the same way do not
// reach files at all.
const DRIVE_WRITE_SCOPES: ReadonlySet<string> = new Set([
  DRIVE_AUTH,
  `${DRIVE_AUTH}.file`,
]);
const DRIVE_READ_SCOPES: ReadonlySet<string> = new Set([
  ...DRIVE_WRITE_SCOPES,
  `${DRIVE_AUTH}.metadata`,
  `${DRIVE_AUTH}.metadata.readonly`,
  `${DRIVE_AUTH}.readonly`,
]);

/** Handles a Drive API request. False when the path is not one. */
export function handleDrive(context: FakeRequest): boolean {
  const upload = context.path.startsWith("/upload/drive/v3/");
  const api = context.path.startsWith("/drive/v3/");

  if (!upload && !api) {
    return false;
  }

  const reading = !upload && ["GET", "HEAD"].includes(context.method);
  const token = requireScope(context, (scope) =>
    (reading ? DRIVE_READ_SCOPES : DRIVE_WRITE_SCOPES).has(scope),
  );

  if (!token) {
    return true;
  }

  const parts = context.path
    .slice(upload ? "/upload/drive/v3/".length : "/drive/v3/".length)
    .split("/")
    .map((part) => decodeURIComponent(part));
  const [resource, id, ...rest] = parts;

  if (upload) {
    if (resource === "files") {
      handleUpload(context, token, id ?? null);
    } else {
      sendGoogleError(context.response, 404, "notFound", "Not Found");
    }

    return true;
  }

  if (resource === "files" && !id) {
    if (context.method === "GET") {
      listFiles(context);
    } else if (context.method === "POST") {
      const file = createFile(
        context,
        token,
        readJsonBody(context.body) ?? {},
        Buffer.alloc(0),
        null,
      );

      if (file) {
        sendMasked(context, fileResource(file), DEFAULT_FILE_FIELDS);
      }
    } else {
      sendGoogleError(context.response, 405, "methodNotAllowed", "Not allowed");
    }

    return true;
  }

  if (resource === "files" && id) {
    handleFile(context, token, id, rest);
    return true;
  }

  if (resource === "drives") {
    handleDrives(context, id ? [id, ...rest] : []);
    return true;
  }

  if (resource === "about" && context.method === "GET") {
    if (!context.query.get("fields")) {
      sendGoogleError(
        context.response,
        400,
        "required",
        "The 'fields' parameter is required for this method.",
      );
      return true;
    }

    const email = creatorOf(token) ?? "";
    const user = email ? context.state.users.get(email) : undefined;

    sendMasked(
      context,
      {
        kind: "drive#about",
        user: {
          displayName: user ? `${user.givenName} ${user.familyName}` : email,
          emailAddress: email,
          kind: "drive#user",
          me: true,
        },
      },
      null,
    );
    return true;
  }

  sendJson(context.response, 404, {
    error: { code: 404, message: `The fake Drive has no ${context.path}.` },
  });
  return true;
}
