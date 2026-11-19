// The names, steps and events of the automatic Google Workspace setup
// (workspace-setup.ts), with nothing that needs the server, so the setup
// page in the browser shows the same names the server uses.

/** Where Google sends the administrator back to: add it to the OAuth client. */
export const SETUP_CALLBACK_PATH = "/settings/google-setup";

/** Where Google sends someone back to after connecting Google Drive. */
export const DRIVE_CALLBACK_PATH = "/api/google/drive/callback";

/** Where Google sends someone back to after signing in (Better Auth's). */
export const SSO_CALLBACK_PATH = "/api/auth/callback/sso";

/** The APIs the app calls, turned on in step a. */
export const SETUP_APIS = [
  "admin.googleapis.com",
  "drive.googleapis.com",
  "picker.googleapis.com",
  "drivelabels.googleapis.com",
  "apikeys.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "cloudresourcemanager.googleapis.com",
] as const;

/** The privileges of the directory role: Users, Read and Groups, Read. */
export const DIRECTORY_ROLE_PRIVILEGES = [
  "USERS_RETRIEVE",
  "GROUPS_RETRIEVE",
] as const;

export function directoryRoleName(appName: string): string {
  return `${appName} directory reader`;
}

// The API Keys API holds a key's display name to 63 characters.
const KEY_NAME_LIMIT = 63;
const PICKER_SUFFIX = " Picker";

export function pickerKeyName(appName: string): string {
  const name = Array.from(appName)
    .slice(0, KEY_NAME_LIMIT - PICKER_SUFFIX.length)
    .join("");

  return `${name.trimEnd()}${PICKER_SUFFIX}`;
}

export function executedDriveName(appName: string): string {
  return `${appName} Executed`;
}

export type SetupStepId =
  "apis" | "customer" | "drive" | "picker" | "role" | "tests";

export type SetupStepStatus = "done" | "failed" | "running" | "skipped";

export type SetupEvent =
  | {
      detail: string;
      /** Google's HTTP status, when Google refused. */
      googleStatus?: number | null;
      /** What to do about a failure. */
      hint?: string;
      id: SetupStepId;
      status: SetupStepStatus;
      title: string;
      type: "step";
    }
  | { hint?: string; message: string; type: "refused" }
  | { ok: boolean; revoked: boolean; type: "finished" };

export const SETUP_STEP_ORDER: readonly SetupStepId[] = [
  "apis",
  "picker",
  "customer",
  "role",
  "drive",
  "tests",
];

export const SETUP_STEP_TITLES: Record<SetupStepId, string> = {
  apis: "Turn on the Google APIs",
  customer: "Read the Workspace customer ID",
  drive: "Create the Shared Drive for executed copies",
  picker: "Create the Picker's API key",
  role: "Let the service account read the directory",
  tests: "Test it with this site's own access",
};
