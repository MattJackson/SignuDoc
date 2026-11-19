import { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  FILES_CONNECT_COOKIE,
  FILES_CONNECT_COOKIE_PATH,
  FILES_CONNECT_MAX_AGE_SECONDS,
  filesRedirectUri,
  getImportableFiles,
  newConnectState,
  safeReturnPath,
  sealConnectState,
  withFilesProblem,
} from "@/lib/workspace/files";
import {
  NO_STORE,
  secureCookies,
  seeOther,
} from "@/lib/workspace/files-routes";

// "Connect": sends the signed-in person to the provider to allow this app
// to read the files they pick, with a state value and the provider's
// secret (a PKCE verifier) kept in a short-lived encrypted cookie. The
// provider sends them back to /api/workspace/files/callback.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return seeOther(
      `/login?next=${encodeURIComponent(`/api/workspace/files/connect?returnTo=${encodeURIComponent(returnTo)}`)}`,
      request,
    );
  }

  const limited = await applyRateLimit({
    category: "workspace_files_connect",
    key: buildRateLimitKey(["files-connect", session.user.id]),
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
    return seeOther(withFilesProblem(returnTo, "not_configured"), request);
  }

  const state = newConnectState();
  const { secret, url: destination } = await files.startConnect({
    email: session.user.email,
    redirectUri,
    state,
  });
  const response = NextResponse.redirect(destination, {
    headers: NO_STORE,
    status: 303,
  });

  response.cookies.set(
    FILES_CONNECT_COOKIE,
    sealConnectState({
      createdAt: Math.floor(Date.now() / 1000),
      returnTo,
      secret,
      state,
      userId: session.user.id,
    }),
    {
      httpOnly: true,
      maxAge: FILES_CONNECT_MAX_AGE_SECONDS,
      path: FILES_CONNECT_COOKIE_PATH,
      // Lax: the provider's redirect back is a top-level GET, which still
      // carries it.
      sameSite: "lax",
      secure: secureCookies(request),
    },
  );

  return response;
}
