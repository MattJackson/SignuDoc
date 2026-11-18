// What the new-envelope page says when a Google Drive step sent someone
// back with ?drive=<problem>. Only these codes are shown, so the address
// cannot be used to put words on the page.

const DRIVE_PROBLEMS: Record<string, string> = {
  bad_request: "Google Drive sent a request this site does not understand.",
  denied:
    "Google Drive was not connected: access to Drive was not allowed. Connect it again and allow it.",
  drive_failed:
    "Google Drive could not turn this file into a PDF. Try again, or save it as a PDF first.",
  encrypted_pdf:
    "This PDF is password-protected or encrypted. Please choose an unlocked PDF.",
  expired: "Connecting Google Drive took too long. Please try again.",
  failed: "Google Drive could not be connected. Please try again.",
  import_failed:
    "The file could not be brought in from Google Drive. Please try again.",
  invalid_type: "Only PDF files and documents that convert to PDF work here.",
  not_configured: "Google Drive is not set up on this site.",
  too_large: "This file exceeds the 20 MB limit.",
  unreadable_pdf: "We couldn't read this PDF. Please choose a valid file.",
  unsupported_type:
    "This kind of file cannot be turned into a PDF. Use a PDF, a Word, OpenDocument or RTF document, or a Google Doc, Sheet or Slides file.",
  unsupported_variant:
    "This PDF uses an unsupported format. Please export it as a standard PDF.",
  upload_failed: "The file could not be saved. Please try again.",
  wrong_account:
    "That Google account is not the one you sign in to this site with. Use your own Workspace account.",
};

export function describeDriveProblem(
  code: string | null | undefined,
): string | null {
  return code && Object.hasOwn(DRIVE_PROBLEMS, code)
    ? (DRIVE_PROBLEMS[code] ?? null)
    : null;
}
