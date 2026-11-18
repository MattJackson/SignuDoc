import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getGoogleWorkspaceView,
  GoogleWorkspaceSettingsError,
  saveGoogleWorkspaceSettings,
  testDirectoryAccess,
  testGroupLookup,
} from "@/lib/google-workspace";
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

// Settings, Google Workspace: Google sign-in, the Workspace directory and
// the administrator group, and the checks an administrator can run on them.
// Administrators only.

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test_directory") }),
  z.object({
    action: z.literal("test_group"),
    group: z.string().trim().max(320).optional(),
  }),
]);

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "google_workspace_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the Google Workspace settings.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

async function limit(request: Request, userId: string) {
  return applyRateLimit({
    category: "google_workspace_settings",
    key: buildRateLimitKey(["google-workspace", userId]),
    limit: 30,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ view: await getGoogleWorkspaceView() });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  try {
    const view = await saveGoogleWorkspaceSettings(
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
    if (error instanceof GoogleWorkspaceSettingsError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: 400 },
      );
    }

    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const result =
      parsed.data.action === "test_directory"
        ? await testDirectoryAccess(session.user.email)
        : await testGroupLookup(
            session.user.email,
            parsed.data.group?.trim() || null,
          );

    return NextResponse.json({ result });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
