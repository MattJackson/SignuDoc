import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { NO_STORE } from "@/lib/drive-routes";
import {
  disconnectDrive,
  getDriveConnection,
} from "@/lib/integrations/google/drive-tokens";
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

// The signed-in person's own Google Drive connection: whether there is one
// (GET), and disconnecting it (DELETE), which revokes the token at Google.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const connection = await getDriveConnection(session.user.id);

  return NextResponse.json(
    {
      connected: connection !== null,
      googleEmail: connection?.googleEmail ?? null,
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
    category: "google_drive_connect",
    key: buildRateLimitKey(["drive-disconnect", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const removed = await disconnectDrive({
      email: session.user.email,
      id: session.user.id,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
    });

    return NextResponse.json({ disconnected: removed }, { headers: NO_STORE });
  } catch (error) {
    logRouteError(error, {
      category: "google_drive_disconnect_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Disconnecting Google Drive failed.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
