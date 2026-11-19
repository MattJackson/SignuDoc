import { timingSafeEqual } from "node:crypto";

import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { seeOther, withDriveProblem } from "@/lib/drive-routes";
import { getIntegrationSettings } from "@/lib/integration-settings";
import {
  DRIVE_OAUTH_COOKIE,
  DriveAuthorizationError,
  driveRedirectUri,
  exchangeAuthorizationCode,
  grantsDriveFile,
  openOAuthState,
  readDriveOAuthClient,
  readIdTokenClaims,
  revokeToken,
} from "@/lib/integrations/google/drive-oauth";
import { connectDrive } from "@/lib/integrations/google/drive-tokens";
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
import { NextResponse } from "next/server";

// Where Google sends someone back after "Connect Google Drive". The state
// must match the cookie set when they left, the same person must still be
// signed in, and the Google account must be theirs. Then the code is
// exchanged (with the PKCE verifier) and the refresh token stored.

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookie = openOAuthState(
    readCookie(request.headers.get("cookie"), DRIVE_OAUTH_COOKIE),
  );
  const state = url.searchParams.get("state") ?? "";

  if (!cookie || !sameValue(cookie.state, state)) {
    return finish(
      seeOther(withDriveProblem("/envelopes/new", "expired"), request),
    );
  }

  const returnTo = cookie.returnTo;
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session || session.user.id !== cookie.userId) {
    return finish(seeOther(withDriveProblem(returnTo, "expired"), request));
  }

  const limited = await applyRateLimit({
    category: "google_drive_connect",
    key: buildRateLimitKey(["drive-callback", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const code = url.searchParams.get("code");

  if (url.searchParams.get("error") || !code) {
    return finish(seeOther(withDriveProblem(returnTo, "denied"), request));
  }

  const client = readDriveOAuthClient(
    process.env,
    await getIntegrationSettings(),
  );
  const redirectUri = driveRedirectUri();

  if (!client || !redirectUri) {
    return finish(
      seeOther(withDriveProblem(returnTo, "not_configured"), request),
    );
  }

  try {
    const token = await exchangeAuthorizationCode({
      client,
      code,
      codeVerifier: cookie.verifier,
      redirectUri,
    });
    const account = readIdTokenClaims(token.idToken);
    const wrongAccount =
      !account || account.email !== session.user.email.trim().toLowerCase();

    if (
      !account ||
      wrongAccount ||
      !token.refreshToken ||
      !grantsDriveFile(token.scope)
    ) {
      // Not kept, so Google is asked to forget it straight away.
      await revokeToken(token.refreshToken ?? token.accessToken);

      return finish(
        seeOther(
          withDriveProblem(returnTo, wrongAccount ? "wrong_account" : "denied"),
          request,
        ),
      );
    }

    await connectDrive(
      {
        googleEmail: account.email,
        googleSubject: account.sub,
        refreshToken: token.refreshToken,
        scope: token.scope,
      },
      {
        email: session.user.email,
        id: session.user.id,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
    );

    return finish(seeOther(returnTo, request));
  } catch (error) {
    if (!(error instanceof DriveAuthorizationError)) {
      logRouteError(error, {
        category: "google_drive_connect_failure",
        ipAddress: getClientIpAddress(request.headers),
        message: "Connecting Google Drive failed.",
        path: getRequestPathname(request),
        userId: session.user.id,
      });
    }

    return finish(seeOther(withDriveProblem(returnTo, "failed"), request));
  }
}

/** The state cookie is used once. */
function finish(response: NextResponse): NextResponse {
  response.cookies.delete({
    name: DRIVE_OAUTH_COOKIE,
    path: "/api/google/drive",
  });

  return response;
}
