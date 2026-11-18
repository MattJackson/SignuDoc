import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getGoogleAddonView,
  GoogleAddonSettingsError,
  saveGoogleAddonSettings,
} from "@/lib/google-addon";
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

// Settings, Google Workspace, the add-on: the deployment JSON with this
// site's URLs (?download=1 sends it as a file, for `gcloud workspace-add-ons
// deployments create`), and the add-on's service account and OAuth client
// ID. Administrators only.

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "google_addon_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the Google Workspace add-on settings.",
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
    const view = await getGoogleAddonView();

    if (new URL(request.url).searchParams.get("download") === "1") {
      if (!view.deployment) {
        return NextResponse.json(
          {
            error:
              "This site does not know its own address yet. Set APP_URL first.",
          },
          { status: 409 },
        );
      }

      return new Response(`${JSON.stringify(view.deployment, null, 2)}\n`, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": 'attachment; filename="signudoc-addon.json"',
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    return NextResponse.json(
      { view },
      { headers: { "cache-control": "private, no-store" } },
    );
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
    category: "google_addon_settings",
    key: buildRateLimitKey(["google-addon-settings", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const view = await saveGoogleAddonSettings(
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
    if (error instanceof GoogleAddonSettingsError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: 400 },
      );
    }

    return failure(request, error, session.user.id);
  }
}
