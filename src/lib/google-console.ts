// Links into Google's consoles for the setup panels in Settings. Pure
// string helpers, so server and client code can both use them.

const GOOGLE_CONSOLE_URL = "https://console.cloud.google.com";

/**
 * The Google Cloud project this site runs in, from its service account's
 * address (name@project.iam.gserviceaccount.com), so links open the right
 * project's console. Null when it is not known.
 */
export function googleProjectId(serviceAccountEmail: string | null) {
  const match =
    /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(
      serviceAccountEmail ?? "",
    );

  return match ? match[1] : null;
}

/** A page of the Google Cloud console, in this site's project if known. */
export function consoleUrl(path: string, project: string | null) {
  return project
    ? `${GOOGLE_CONSOLE_URL}${path}?project=${encodeURIComponent(project)}`
    : `${GOOGLE_CONSOLE_URL}${path}`;
}

/** The API library page of one API, such as "drive.googleapis.com". */
export function apiLibraryUrl(api: string, project: string | null) {
  return consoleUrl(`/apis/library/${api}`, project);
}

/** The scheme and host of a URL, which Google calls its origin. */
export function originOf(url: string | null): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}
