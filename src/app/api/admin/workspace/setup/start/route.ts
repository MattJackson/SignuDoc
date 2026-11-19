import { NextResponse } from "next/server";

import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { isHostedMode } from "@/lib/utils/env";
import {
  NO_STORE,
  secureCookies,
  seeOther,
} from "@/lib/workspace/files-routes";
import {
  describeSetupSite,
  getAutomaticSetup,
  newSetupStateValue,
  readSetupToggles,
  sealSetupState,
  SETUP_COOKIE,
  SETUP_COOKIE_MAX_AGE_SECONDS,
  SETUP_COOKIE_PATH,
  WORKSPACE_SETUP_PATH,
} from "@/lib/workspace/workspace-setup";

// "Sign in and set it up": sends an administrator of this site to the
// provider (?provider=, or the default one) to sign in once as its
// administrator, with a state value and the provider's secret (a PKCE
// verifier) kept in a short-lived encrypted cookie. The provider sends
// them back to the setup page, which runs the setup
// (/api/admin/workspace/setup/run).

export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return seeOther(
      `/login?next=${encodeURIComponent(WORKSPACE_SETUP_PATH)}`,
      request,
    );
  }

  if (isHostedMode() || !(await isAdminUser(session.user.id))) {
    return seeOther("/settings", request);
  }

  const limited = await applyRateLimit({
    category: "workspace_setup",
    key: buildRateLimitKey(["workspace-setup-start", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const found = await getAutomaticSetup(url.searchParams.get("provider"));
  const site = await describeSetupSite();
  const info = found?.automatic.describe(site);
  const redirectUri = site.callbacks.setup;

  if (!found || !info || info.problem || !redirectUri) {
    return seeOther(`${WORKSPACE_SETUP_PATH}?error=not_ready`, request);
  }

  const toggles = readSetupToggles(info, url.searchParams);
  const state = newSetupStateValue();
  const { secret, url: destination } = found.automatic.start({
    redirectUri,
    state,
    toggles,
  });
  const response = NextResponse.redirect(destination, {
    headers: NO_STORE,
    status: 303,
  });

  response.cookies.set(
    SETUP_COOKIE,
    sealSetupState({
      createdAt: Math.floor(Date.now() / 1000),
      provider: found.provider.id,
      secret,
      state,
      toggles,
      userId: session.user.id,
    }),
    {
      httpOnly: true,
      maxAge: SETUP_COOKIE_MAX_AGE_SECONDS,
      path: SETUP_COOKIE_PATH,
      // Lax: the provider's redirect back is a top-level GET to the setup
      // page; the page then posts to the run route on this site.
      sameSite: "lax",
      secure: secureCookies(request),
    },
  );

  return response;
}
