import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { describeImportFailure, NO_STORE } from "@/lib/drive-routes";
import {
  importDriveFileAsDraft,
  isDriveFileId,
} from "@/lib/integrations/google/drive-import";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// A draft from a file chosen in the Google Picker on the new-envelope page.

// Converting and exporting through Drive can take a while for a big file.
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  // The same allowance as creating a draft by upload.
  const limited = await applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => null)) as {
    fileId?: unknown;
  } | null;

  const fileId = body?.fileId;

  if (!isDriveFileId(fileId)) {
    return NextResponse.json(
      { error: "Choose a file from Google Drive." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await importDriveFileAsDraft(session.user.id, fileId),
      { headers: NO_STORE, status: 201 },
    );
  } catch (error) {
    const known = describeImportFailure(error);

    if (known) {
      return NextResponse.json(
        { error: known.message },
        { headers: NO_STORE, status: known.status },
      );
    }

    logRouteError(error, {
      category: "draft_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating a draft from Google Drive.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to create the draft envelope." },
      { status: 500 },
    );
  }
}
