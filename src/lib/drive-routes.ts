import { NextResponse } from "next/server";

import { DocumentConversionError } from "./integrations/google/convert.ts";
import { DriveAuthorizationError } from "./integrations/google/drive-oauth.ts";
import { ImportDraftAccountError } from "./integrations/google/import-draft.ts";
import { DocumentImportError } from "./services/document-import.ts";
import { resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// Small pieces shared by the Google Drive routes under /api/google/drive.

export const NO_STORE = { "cache-control": "private, no-store" } as const;

/** This site's own address, for redirects that must not trust the Host. */
export function siteBase(
  request: Request,
  env: EnvSource = process.env,
): string {
  try {
    const configured = resolveAuthUrl(env)?.replace(/\/+$/, "");

    if (configured) {
      return configured;
    }
  } catch {
    // Fall back to the request's own address below.
  }

  return new URL(request.url).origin;
}

/** A 303 to a path on this site. */
export function seeOther(path: string, request: Request): NextResponse {
  return NextResponse.redirect(`${siteBase(request)}${path}`, {
    headers: NO_STORE,
    status: 303,
  });
}

export function secureCookies(request: Request): boolean {
  return siteBase(request).startsWith("https://");
}

/** Adds ?drive=<problem> to a path, for the page to explain. */
export function withDriveProblem(path: string, problem: string): string {
  const url = new URL(path, "http://placeholder");

  url.searchParams.set("drive", problem);

  return `${url.pathname}${url.search}`;
}

export type DraftFailure = { message: string; status: number };

/** How an import that went wrong is told to the person. */
export function describeImportFailure(error: unknown): DraftFailure | null {
  if (
    error instanceof DocumentImportError ||
    error instanceof DocumentConversionError
  ) {
    return { message: error.message, status: 400 };
  }

  if (error instanceof ImportDraftAccountError) {
    return {
      message: "Verify your email address before continuing.",
      status: 403,
    };
  }

  if (error instanceof DriveAuthorizationError) {
    return {
      message:
        error.code === "not_configured"
          ? "Google Drive is not set up on this site."
          : "Connect Google Drive, then try again.",
      status: 409,
    };
  }

  return null;
}

export function driveOpenFailure(
  error: unknown,
): { connect: true } | { problem: string } | null {
  if (!(error instanceof DriveAuthorizationError)) {
    return null;
  }

  return error.code === "not_configured"
    ? { problem: "not_configured" }
    : { connect: true };
}
