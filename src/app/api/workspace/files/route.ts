import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
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
import {
  getImportableFiles,
  recordFilesConnectionChange,
} from "@/lib/workspace/files";
import { NO_STORE } from "@/lib/workspace/files-routes";

// The signed-in person's own connection to their workspace files: whether
// there is one (GET), and disconnecting it (DELETE), which revokes it at
// the provider.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const files = await getImportableFiles();
  const connection = files ? await files.connection(session.user.id) : null;

  return NextResponse.json(
    {
      account: connection?.account ?? null,
      available: files !== null,
      connected: connection !== null,
    },
    { headers: NO_STORE },
  );
}

export async function DELETE(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "workspace_files_connect",
    key: buildRateLimitKey(["files-disconnect", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const files = await getImportableFiles();
    const removed = files ? await files.disconnect(session.user.id) : false;

    if (removed) {
      await recordFilesConnectionChange(
        "workspace_files_disconnected",
        {
          email: session.user.email,
          id: session.user.id,
          ipAddress: getClientIpAddress(request.headers),
          userAgent: getRequestUserAgent(request.headers),
        },
        null,
      );
    }

    return NextResponse.json({ disconnected: removed }, { headers: NO_STORE });
  } catch (error) {
    logRouteError(error, {
      category: "workspace_files_disconnect_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Disconnecting workspace files failed.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
