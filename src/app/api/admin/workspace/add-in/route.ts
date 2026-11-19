import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { checkAddIn, getAddInSettingsView } from "@/lib/workspace/add-in";

// Settings, the workspace add-in: how to deploy it with this site's URLs
// (?download=1 sends the provider's deployment file), the values the
// provider gives back, and the checks. Administrators only.

const NO_STORE = { "cache-control": "private, no-store" } as const;

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "workspace_add_in_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the workspace add-in settings.",
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
    const view = await getAddInSettingsView();

    if (!view) {
      return NextResponse.json(
        { error: "No workspace provider is chosen for the add-in." },
        { status: 409 },
      );
    }

    if (new URL(request.url).searchParams.get("download") === "1") {
      const file = view.deployment?.file;

      if (!file) {
        return NextResponse.json(
          {
            error:
              "This site does not know its own address yet. Set APP_URL first.",
          },
          { status: 409 },
        );
      }

      return new Response(file.content, {
        headers: {
          ...NO_STORE,
          "content-disposition": buildContentDisposition(file.name),
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    return NextResponse.json({ view }, { headers: NO_STORE });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "workspace_add_in_settings",
    key: buildRateLimitKey(["workspace-add-in", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
  } | null;

  if (body?.action !== "check") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    return NextResponse.json(
      { checks: await checkAddIn() },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
