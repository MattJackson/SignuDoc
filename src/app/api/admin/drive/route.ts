import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getGoogleDriveView,
  GoogleDriveSettingsError,
  listExportsForSettings,
  listLabelsForSettings,
  listSharedDrives,
  retryExportForSettings,
  saveGoogleDriveSettings,
  testSharedDrive,
} from "@/lib/google-drive";
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

// Settings, Google Workspace, Google Drive: the Picker, the Shared Drive
// for executed copies and its labels, the checks an administrator can run,
// and the state of each export with a way to try one again.
// Administrators only. Every saved change is in the site audit trail.

export const maxDuration = 60;

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_drives") }),
  z.object({
    action: z.literal("test_drive"),
    driveId: z.string().trim().max(400).optional(),
  }),
  z.object({ action: z.literal("list_labels") }),
  z.object({
    action: z.literal("list_exports"),
    status: z.enum(["exported", "failed", "pending"]).optional(),
  }),
  z.object({
    action: z.literal("retry_export"),
    envelopeId: z.string().trim().min(1).max(100),
  }),
]);

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "google_drive_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the Google Drive settings.",
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
    category: "google_drive_settings",
    key: buildRateLimitKey(["google-drive", userId]),
    limit: 60,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

function actorFor(
  request: Request,
  session: { user: { email: string; id: string } },
) {
  return {
    email: session.user.email,
    id: session.user.id,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
  };
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ view: await getGoogleDriveView() });
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
    const view = await saveGoogleDriveSettings(
      await request.json().catch(() => null),
      actorFor(request, session),
    );

    return NextResponse.json({ view });
  } catch (error) {
    if (error instanceof GoogleDriveSettingsError) {
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
    const input = parsed.data;

    switch (input.action) {
      case "list_drives":
        return NextResponse.json({ result: await listSharedDrives() });
      case "test_drive":
        return NextResponse.json({
          result: await testSharedDrive(input.driveId?.trim() || null),
        });
      case "list_labels":
        return NextResponse.json({ result: await listLabelsForSettings() });
      case "list_exports":
        return NextResponse.json({
          exports: await listExportsForSettings(input.status),
        });
      case "retry_export":
        return NextResponse.json({
          result: await retryExportForSettings(
            input.envelopeId,
            actorFor(request, session),
          ),
        });
    }
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
