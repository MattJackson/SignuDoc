import { randomBytes } from "node:crypto";

import { type DbPool, getDb } from "../db/connection.ts";
import { createDraftEnvelope } from "../envelopes.ts";
import { DocumentImportError } from "../services/document-import.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import type { StorageService } from "../services/storage.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { resolveAuthUrl, type EnvSource } from "../utils/env.ts";
import { getWorkspaceFiles } from "./registry.ts";
import {
  FileImportError,
  FilesConnectionError,
  type WorkspaceFiles,
} from "./types.ts";

// Starting an envelope from a file in the workspace, the app's side of it:
// the page that offers it, each person's connection (the OAuth state kept
// between leaving for the provider and coming back), the draft made from
// the file, and what a person is told when something goes wrong. The
// provider does the rest (types.ts, WorkspaceFiles).

/** The page that offers the provider's picker. */
export const FILES_START_PATH = "/envelopes/new/files";
/** Where the provider sends the person back after connecting. */
export const FILES_CALLBACK_PATH = "/api/workspace/files/callback";
export const FILES_CONNECT_COOKIE = "signudoc_files_connect";
/** The cookie is only sent to the connect routes. */
export const FILES_CONNECT_COOKIE_PATH = "/api/workspace/files";
export const FILES_CONNECT_MAX_AGE_SECONDS = 10 * 60;

const STATE_CONTEXT = "signudoc/workspace-files-connect/v1";

/** This site's callback address, or null when it does not know its URL. */
export function filesRedirectUri(env: EnvSource = process.env): string | null {
  try {
    const url = resolveAuthUrl(env)?.replace(/\/+$/, "");

    return url ? `${url}${FILES_CALLBACK_PATH}` : null;
  } catch {
    return null;
  }
}

function hasSpaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 32 || code === 127) {
      return true;
    }
  }

  return false;
}

/**
 * A path on this site to send someone back to, from a value the browser
 * sent. Never another site, nor a "//host" address a browser would read as
 * one.
 */
export function safeReturnPath(
  value: unknown,
  fallback: string = FILES_START_PATH,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.length > 2000 ||
    hasSpaceOrControl(value)
  ) {
    return fallback;
  }

  return value;
}

/** What is kept in the cookie while the person is at the provider. */
export type ConnectState = {
  createdAt: number;
  returnTo: string;
  /** The provider's secret for this flow (a PKCE verifier). */
  secret: string;
  state: string;
  userId: string;
};

export function newConnectState(): string {
  return randomBytes(24).toString("base64url");
}

export function sealConnectState(
  value: ConnectState,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(
    JSON.stringify(value),
    secretKeyFor(STATE_CONTEXT, env),
  );
}

/** The cookie's contents, or null when it is missing, forged or too old. */
export function openConnectState(
  sealed: string | null | undefined,
  env: EnvSource = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): ConnectState | null {
  if (!sealed) {
    return null;
  }

  const json = decryptPrivateKey(sealed, secretKeyFor(STATE_CONTEXT, env));

  if (!json) {
    return null;
  }

  try {
    const value = JSON.parse(json) as Partial<ConnectState>;

    if (
      typeof value.state !== "string" ||
      typeof value.secret !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.returnTo !== "string" ||
      typeof value.createdAt !== "number" ||
      nowSeconds - value.createdAt > FILES_CONNECT_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return value as ConnectState;
  } catch {
    return null;
  }
}

/** The provider's files when people can start envelopes from them. */
export async function getImportableFiles(
  env: EnvSource = process.env,
): Promise<WorkspaceFiles | null> {
  try {
    const files = await getWorkspaceFiles(env);

    return files?.canImport && filesRedirectUri(env) ? files : null;
  } catch (error) {
    console.warn(
      "[workspace] Could not read the files setup:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export type FilesStartState = {
  /** The person's account at the provider, when connected. */
  account: string | null;
  connected: boolean;
  /** "Google Drive". */
  name: string;
};

/**
 * What the new-envelope pages need to offer starting from a file, or null
 * when it is not offered. Never throws.
 */
export async function getFilesStartState(
  userId: string,
  env: EnvSource = process.env,
): Promise<FilesStartState | null> {
  const files = await getImportableFiles(env);

  if (!files) {
    return null;
  }

  try {
    const connection = await files.connection(userId);

    return {
      account: connection?.account ?? null,
      connected: connection !== null,
      name: files.name,
    };
  } catch {
    return { account: null, connected: false, name: files.name };
  }
}

/** A draft from a file the person picked, made the same way as an upload. */
export async function importFileAsDraft(
  files: WorkspaceFiles,
  input: { fileId: string; userId: string },
  {
    database = getDb(),
    storageService,
  }: { database?: DbPool; storageService?: StorageService } = {},
) {
  const document = await files.importFile(input);

  return createDraftEnvelope(
    input.userId,
    {
      sourcePdf: {
        body: document.bytes,
        contentType: "application/pdf",
        filename: document.fileName,
      },
      title: draftTitleFromFileName(document.fileName),
    },
    { database, ...(storageService ? { storageService } : {}) },
  );
}

/** A title for the draft from the document's name. */
export function draftTitleFromFileName(fileName: string): string {
  const title = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .trim();

  return title || "Untitled document";
}

export type ImportFailure = {
  /** Whether connecting (again) would help. */
  connect: boolean;
  message: string;
  status: number;
};

/**
 * How an import or picker failure is told to the person, or null for one
 * that is not theirs to fix (logged as an error by the route).
 */
export function describeImportFailure(error: unknown): ImportFailure | null {
  if (
    error instanceof DocumentImportError ||
    error instanceof FileImportError
  ) {
    return { connect: false, message: error.message, status: 400 };
  }

  if (error instanceof FilesConnectionError) {
    switch (error.code) {
      case "not_configured":
        return {
          connect: false,
          message: "Starting from a file is not set up on this site.",
          status: 409,
        };
      case "not_connected":
        return {
          connect: true,
          message: "Connect your files, then try again.",
          status: 409,
        };
      default:
        // The provider could not be reached: the connection is fine.
        return null;
    }
  }

  return null;
}

// What the start page says when connecting sent someone back with
// ?files=<problem>. Only these codes are shown, so the address cannot be
// used to put words on the page.
const FILES_PROBLEMS: Record<string, string> = {
  denied:
    "Your files were not connected: access was not allowed. Connect again and allow it.",
  expired: "Connecting took too long. Please try again.",
  failed: "Your files could not be connected. Please try again.",
  not_configured: "Starting from a file is not set up on this site.",
  not_connected: "Your files are not connected. Connect them and try again.",
  wrong_account:
    "That account is not the one you sign in to this site with. Use your own work account.",
};

export function describeFilesProblem(
  code: string | null | undefined,
): string | null {
  return code && Object.hasOwn(FILES_PROBLEMS, code)
    ? (FILES_PROBLEMS[code] ?? null)
    : null;
}

/** Adds ?files=<problem> to a path, for the page to explain. */
export function withFilesProblem(path: string, problem: string): string {
  const url = new URL(path, "http://placeholder");

  url.searchParams.set("files", problem);

  return `${url.pathname}${url.search}`;
}

type AuditActor = {
  email: string;
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Records a person connecting or disconnecting their files. */
export async function recordFilesConnectionChange(
  event: "workspace_files_connected" | "workspace_files_disconnected",
  actor: AuditActor,
  metadata: Record<string, unknown> | null,
  database: DbPool = getDb(),
): Promise<void> {
  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event,
      ipAddress: actor.ipAddress ?? null,
      metadata,
      targetUserId: actor.id,
      userAgent: actor.userAgent ?? null,
    },
    database,
  );
}
