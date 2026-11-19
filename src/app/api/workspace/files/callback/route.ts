import { timingSafeEqual } from "node:crypto";

import type { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { readCookie } from "@/lib/signer-checks";
import {
  FILES_CONNECT_COOKIE,
  FILES_CONNECT_COOKIE_PATH,
  FILES_START_PATH,
  filesRedirectUri,
  getImportableFiles,
  openConnectState,
  recordFilesConnectionChange,
  withFilesProblem,
} from "@/lib/workspace/files";
import { seeOther } from "@/lib/workspace/files-routes";
import { FilesConnectionError } from "@/lib/workspace/types";

// Where the provider sends someone back after "Connect". The state must
// match the cookie set when they left, the same person must still be
// signed in, and the provider checks that the account is theirs. Then the
// provider keeps the connection.

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookie = openConnectState(
    readCookie(request.headers.get("cookie"), FILES_CONNECT_COOKIE),
  );
  const state = url.searchParams.get("state") ?? "";

  if (!cookie || !sameValue(cookie.state, state)) {
    return finish(
      seeOther(withFilesProblem(FILES_START_PATH, "expired"), request),
    );
  }

  const returnTo = cookie.returnTo;
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session || session.user.id !== cookie.userId) {
    return finish(seeOther(withFilesProblem(returnTo, "expired"), request));
  }

  const limited = await applyRateLimit({
    category: "workspace_files_connect",
    key: buildRateLimitKey(["files-callback", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const files = await getImportableFiles();
  const redirectUri = filesRedirectUri();

  if (!files || !redirectUri) {
    return finish(
      seeOther(withFilesProblem(returnTo, "not_configured"), request),
    );
  }

  const actor = {
    email: session.user.email,
    id: session.user.id,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
  };

  try {
    const connection = await files.finishConnect({
      email: session.user.email,
      params: url.searchParams,
      redirectUri,
      secret: cookie.secret,
      userId: session.user.id,
    });

    await recordFilesConnectionChange("workspace_files_connected", actor, {
      account: connection.account,
      provider: files.name,
    });

    return finish(seeOther(returnTo, request));
  } catch (error) {
    if (error instanceof FilesConnectionError) {
      return finish(seeOther(withFilesProblem(returnTo, error.code), request));
    }

    logRouteError(error, {
      category: "workspace_files_connect_failure",
      ipAddress: actor.ipAddress,
      message: "Connecting workspace files failed.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return finish(seeOther(withFilesProblem(returnTo, "failed"), request));
  }
}

/** The state cookie is used once. */
function finish(response: NextResponse): NextResponse {
  response.cookies.delete({
    name: FILES_CONNECT_COOKIE,
    path: FILES_CONNECT_COOKIE_PATH,
  });

  return response;
}
