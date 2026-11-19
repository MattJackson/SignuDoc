// Links into Google's consoles for the setup, in the right Cloud project
// when it is known. Pure string helpers.

const GOOGLE_CONSOLE_URL = "https://console.cloud.google.com";

/**
 * The Cloud project of a service account, from its address
 * (name@project.iam.gserviceaccount.com). Null when it is not one.
 */
export function googleProjectId(serviceAccountEmail: string | null) {
  const match =
    /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(
      serviceAccountEmail ?? "",
    );

  return match ? match[1]! : null;
}

/** A page of the Google Cloud console, in this project if known. */
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

export const ADMIN_ROLES_URL = "https://admin.google.com/ac/roles";
export const ADMIN_ACCOUNT_SETTINGS_URL =
  "https://admin.google.com/ac/accountsettings/profile";
export const SHARED_DRIVES_URL = "https://drive.google.com/drive/shared-drives";
export const MARKETPLACE_CONFIG_PATH =
  "/apis/api/appsmarket-component.googleapis.com/googleapps_sdk";
