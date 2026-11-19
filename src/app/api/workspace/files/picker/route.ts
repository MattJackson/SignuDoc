import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  describeImportFailure,
  getImportableFiles,
} from "@/lib/workspace/files";
import { NO_STORE } from "@/lib/workspace/files-routes";

// What the provider's picker needs in the browser, tagged with the
// provider: for Google, the person's own drive.file access token
// (short-lived; the refresh token never leaves the server), the browser
// API key and the Cloud project number. Only for the person signed in.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "workspace_files_picker",
    key: buildRateLimitKey(["files-picker", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const files = await getImportableFiles();

  if (!files) {
    return NextResponse.json(
      { error: "Starting from a file is not set up on this site." },
      { headers: NO_STORE, status: 404 },
    );
  }

  try {
    return NextResponse.json(await files.pickerConfig(session.user.id), {
      headers: NO_STORE,
    });
  } catch (error) {
    const known = describeImportFailure(error);

    if (known) {
      return NextResponse.json(
        { connect: known.connect, error: known.message },
        { headers: NO_STORE, status: known.status },
      );
    }

    logRouteError(error, {
      category: "workspace_files_picker_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Could not get what the file picker needs.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: `${files.name} could not be reached. Please try again.` },
      { headers: NO_STORE, status: 502 },
    );
  }
}
