import { DocumentConversionError } from "./integrations/google/convert.ts";
import { DriveAuthorizationError } from "./integrations/google/drive-oauth.ts";
import { ImportDraftAccountError } from "./integrations/google/import-draft.ts";
import { DocumentImportError } from "./services/document-import.ts";

// The decisions the Google Drive routes make about a failure, apart from
// the route code, so they can be tested without a web server.

export type DraftFailure = { message: string; status: number };

/** How an import that went wrong is told to the person. */
export function describeImportFailure(error: unknown): DraftFailure | null {
  if (
    error instanceof DocumentImportError ||
    error instanceof DocumentConversionError
  ) {
    return { message: error.message, status: 400 };
  }

  if (error instanceof ImportDraftAccountError) {
    return {
      message: "Verify your email address before continuing.",
      status: 403,
    };
  }

  if (error instanceof DriveAuthorizationError) {
    return {
      message:
        error.code === "not_configured"
          ? "Google Drive is not set up on this site."
          : "Connect Google Drive, then try again.",
      status: 409,
    };
  }

  return null;
}

/**
 * What Drive's "Open with" does when Google Drive cannot be used: send the
 * person to connect, show a problem on the new-envelope page, or null for
 * anything else.
 */
export function driveOpenFailure(
  error: unknown,
): { connect: true } | { problem: string } | null {
  if (!(error instanceof DriveAuthorizationError)) {
    return null;
  }

  return error.code === "not_configured"
    ? { problem: "not_configured" }
    : { connect: true };
}
