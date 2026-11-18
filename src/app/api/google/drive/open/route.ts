import { getAuthSessionFromHeaders } from "@/lib/auth/server";
import { describeDriveProblem } from "@/lib/drive-problems";
import {
  driveOpenFailure,
  seeOther,
  withDriveProblem,
} from "@/lib/drive-routes";
import { DocumentConversionError } from "@/lib/integrations/google/convert";
import {
  importDriveFileAsDraft,
  parseDriveOpenState,
} from "@/lib/integrations/google/drive-import";
import { getDriveConnection } from "@/lib/integrations/google/drive-tokens";
import { DocumentImportError } from "@/lib/services/document-import";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Drive's "Open with": the open URL set in the Cloud console's Drive UI
// integration. Drive sends the person here with a state parameter naming
// the file. The person must be signed in to this site (they are sent to
// sign in and back), have connected Google Drive with the same Google
// account that opened the file, and then a draft is made from the file and
// they continue on its first preparing step.

export const maxDuration = 60;

const NEW_ENVELOPE = "/envelopes/new";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const here = `${url.pathname}${url.search}`;
  // A problem already on the address means the last try failed; show it
  // rather than try again and loop.
  const earlier = url.searchParams.get("drive");

  if (describeDriveProblem(earlier) !== null && earlier) {
    return seeOther(withDriveProblem(NEW_ENVELOPE, earlier), request);
  }

  const state = parseDriveOpenState(url.searchParams.get("state"));

  if (!state) {
    return seeOther(withDriveProblem(NEW_ENVELOPE, "bad_request"), request);
  }

  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return seeOther(`/login?next=${encodeURIComponent(here)}`, request);
  }

  if (session.user.emailVerified !== true) {
    return seeOther("/dashboard", request);
  }

  // "New" in Drive has no file to bring in: the new-envelope page it is.
  if (state.action === "create" || !state.fileId) {
    return seeOther(NEW_ENVELOPE, request);
  }

  const connection = await getDriveConnection(session.user.id);

  if (!connection) {
    return seeOther(
      `/api/google/drive/connect?returnTo=${encodeURIComponent(here)}`,
      request,
    );
  }

  if (state.googleUserId && state.googleUserId !== connection.googleSubject) {
    return seeOther(withDriveProblem(NEW_ENVELOPE, "wrong_account"), request);
  }

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

  try {
    const draft = await importDriveFileAsDraft(session.user.id, state.fileId);

    return seeOther(draft.redirectPath, request);
  } catch (error) {
    if (
      error instanceof DocumentImportError ||
      error instanceof DocumentConversionError
    ) {
      return seeOther(withDriveProblem(NEW_ENVELOPE, error.code), request);
    }

    const failure = driveOpenFailure(error);

    if (failure) {
      return seeOther(
        "problem" in failure
          ? withDriveProblem(NEW_ENVELOPE, failure.problem)
          : `/api/google/drive/connect?returnTo=${encodeURIComponent(here)}`,
        request,
      );
    }

    logRouteError(error, {
      category: "draft_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while opening a file from Google Drive.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return seeOther(withDriveProblem(NEW_ENVELOPE, "import_failed"), request);
  }
}
