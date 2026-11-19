import { NextResponse } from "next/server";

import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { NO_STORE, secureCookies, seeOther } from "@/lib/drive-routes";
import { describeSetupTarget } from "@/lib/google-workspace-setup";
import {
  buildSetupAuthorizationUrl,
  newSetupState,
  sealSetupState,
  SETUP_CALLBACK_PATH,
  SETUP_COOKIE,
  SETUP_COOKIE_MAX_AGE_SECONDS,
  SETUP_COOKIE_PATH,
} from "@/lib/integrations/google/workspace-setup";
import { safeReturnPath } from "@/lib/return-path";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { isHostedMode } from "@/lib/utils/env";

// "Sign in as a Workspace super admin and set everything up": sends an
// administrator of this site to Google with the setup's scopes, PKCE and a
// state value kept in a short-lived encrypted cookie. Google sends them
// back to /settings/google-setup, which runs the setup
// (api/admin/google/setup/run).

export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return seeOther(
      `/login?next=${encodeURIComponent(SETUP_CALLBACK_PATH)}`,
      request,
    );
  }

  if (isHostedMode() || !(await isAdminUser(session.user.id))) {
    return seeOther("/settings", request);
  }

  const limited = await applyRateLimit({
    category: "google_workspace_setup",
    key: buildRateLimitKey(["google-setup", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const target = await describeSetupTarget();

  if (target.problem || !target.client || !target.redirectUri) {
    return seeOther(`${SETUP_CALLBACK_PATH}?error=not_ready`, request);
  }

  const exportDrive = url.searchParams.get("export") !== "0";
  const { challenge, state, verifier } = newSetupState();
  const response = NextResponse.redirect(
    buildSetupAuthorizationUrl({
      clientId: target.client.clientId,
      codeChallenge: challenge,
      exportDrive,
      redirectUri: target.redirectUri,
      state,
    }),
    { headers: NO_STORE, status: 303 },
  );

  response.cookies.set(
    SETUP_COOKIE,
    sealSetupState({
      createdAt: Math.floor(Date.now() / 1000),
      exportDrive,
      returnTo: safeReturnPath(
        url.searchParams.get("returnTo"),
        SETUP_CALLBACK_PATH,
      ),
      state,
      userId: session.user.id,
      verifier,
    }),
    {
      httpOnly: true,
      maxAge: SETUP_COOKIE_MAX_AGE_SECONDS,
      path: SETUP_COOKIE_PATH,
      sameSite: "lax",
      secure: secureCookies(request),
    },
  );

  return response;
}
