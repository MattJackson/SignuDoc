import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { describeImportFailure, NO_STORE } from "@/lib/drive-routes";
import { getIntegrationSettings } from "@/lib/integration-settings";
import { readPickerConfig } from "@/lib/integrations/google/drive-config";
import { getUserDriveAccessToken } from "@/lib/integrations/google/drive-tokens";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// What the Google Picker needs in the browser: the person's own drive.file
// access token (short-lived; the refresh token never leaves the server),
// the browser API key and the Cloud project number. Only for the person
// signed in, and only their own token.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "google_drive_picker",
    key: buildRateLimitKey(["drive-picker", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const picker = readPickerConfig(process.env, await getIntegrationSettings());

  if (!picker.ready) {
    return NextResponse.json(
      { error: "The Google Drive picker is not set up on this site." },
      { headers: NO_STORE, status: 404 },
    );
  }

  try {
    return NextResponse.json(
      {
        accessToken: await getUserDriveAccessToken(session.user.id),
        apiKey: picker.apiKey,
        appId: picker.appId,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const known = describeImportFailure(error);

    if (known) {
      return NextResponse.json(
        { connect: known.status === 409, error: known.message },
        { headers: NO_STORE, status: known.status },
      );
    }

    logRouteError(error, {
      category: "google_drive_picker_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Could not get a Drive access token for the picker.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Google Drive could not be reached. Please try again." },
      { headers: NO_STORE, status: 502 },
    );
  }
}
