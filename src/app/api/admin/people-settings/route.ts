import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getPeopleSettingsView,
  PeopleSettingsError,
  savePeopleSettings,
} from "@/lib/people-settings";
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

// Settings, Google Workspace, People: the rule about the sender's manager
// approving first, employees signing with Google, and the offboarding check
// against the directory (people-settings.ts). Administrators only.

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "google_workspace_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the people settings.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ view: await getPeopleSettingsView() });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "google_workspace_settings",
    key: buildRateLimitKey(["people-settings", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const view = await savePeopleSettings(
      await request.json().catch(() => null),
      {
        email: session.user.email,
        id: session.user.id,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
    );

    return NextResponse.json({ view });
  } catch (error) {
    if (error instanceof PeopleSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return failure(request, error, session.user.id);
  }
}
