import { randomBytes } from "node:crypto";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import {
  NO_STORE,
  secureCookies,
  seeOther,
  withDriveProblem,
} from "@/lib/drive-routes";
import { getIntegrationSettings } from "@/lib/integration-settings";
import {
  buildAuthorizationUrl,
  createPkcePair,
  DRIVE_OAUTH_COOKIE,
  DRIVE_OAUTH_COOKIE_MAX_AGE_SECONDS,
  driveRedirectUri,
  readDriveOAuthClient,
  safeReturnPath,
  sealOAuthState,
} from "@/lib/integrations/google/drive-oauth";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { NextResponse } from "next/server";

// "Connect Google Drive": sends the signed-in person to Google to allow
// drive.file for this app, with PKCE and a state value kept in a short-lived
// encrypted cookie. Google sends them back to /api/google/drive/callback.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return seeOther(
      `/login?next=${encodeURIComponent(`/api/google/drive/connect?returnTo=${encodeURIComponent(returnTo)}`)}`,
      request,
    );
  }

  const limited = await applyRateLimit({
    category: "google_drive_connect",
    key: buildRateLimitKey(["drive-connect", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const client = readDriveOAuthClient(
    process.env,
    await getIntegrationSettings(),
  );
  const redirectUri = driveRedirectUri();

  if (!client || !redirectUri) {
    return seeOther(withDriveProblem(returnTo, "not_configured"), request);
  }

  const { challenge, verifier } = createPkcePair();
  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(
    buildAuthorizationUrl({
      client,
      codeChallenge: challenge,
      loginHint: session.user.email,
      redirectUri,
      state,
    }),
    { headers: NO_STORE, status: 303 },
  );

  response.cookies.set(
    DRIVE_OAUTH_COOKIE,
    sealOAuthState({
      createdAt: Math.floor(Date.now() / 1000),
      returnTo,
      state,
      userId: session.user.id,
      verifier,
    }),
    {
      httpOnly: true,
      maxAge: DRIVE_OAUTH_COOKIE_MAX_AGE_SECONDS,
      path: "/api/google/drive",
      // Lax: Google's redirect back is a top-level GET, which still carries it.
      sameSite: "lax",
      secure: secureCookies(request),
    },
  );

  return response;
}
