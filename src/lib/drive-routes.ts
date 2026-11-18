import { NextResponse } from "next/server";

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

export {
  describeImportFailure,
  driveOpenFailure,
  type DraftFailure,
} from "./drive-failures.ts";
