// The names and steps of the Google Workspace setup, step by step and
// automatic, so the guide and the automatic run give things the same
// names. Pure strings: nothing here reaches Google.

/** The APIs the site calls. None of them needs billing. */
export const SETUP_APIS = [
  "admin.googleapis.com",
  "drive.googleapis.com",
  "picker.googleapis.com",
  "drivelabels.googleapis.com",
  "apikeys.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "gsuiteaddons.googleapis.com",
  "gmail.googleapis.com",
  "appsmarket-component.googleapis.com",
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

// A service account's ID is 6 to 30 characters: a lowercase letter, then
// letters, digits and hyphens, not ending in a hyphen.
const ACCOUNT_SUFFIX = "-workspace";

function slug(appName: string, room: number): string {
  const base = appName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, room)
    .replace(/-+$/, "");

  return base || "signudoc";
}

/** The ID of the service account the setup makes off Google Cloud. */
export function workspaceAccountId(appName: string): string {
  return `${slug(appName, 30 - ACCOUNT_SUFFIX.length)}${ACCOUNT_SUFFIX}`;
}

/** The address of that service account in a project. */
export function workspaceAccountEmail(
  appName: string,
  projectId: string,
): string {
  return `${workspaceAccountId(appName)}@${projectId}.iam.gserviceaccount.com`;
}

/** The name of the Cloud project the setup can make: "<App> Workspace". */
export function workspaceProjectName(appName: string): string {
  // Project names allow letters, digits, spaces, quotes, hyphens and
  // exclamation marks, 4 to 30 characters.
  return `${
    appName
      .replace(/[^A-Za-z0-9 '"!-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20)
      .trim() || "SignuDoc"
  } Workspace`;
}

/** A new project's ID: the app's name and a few random letters, 6 to 30. */
export function workspaceProjectId(appName: string, random: string): string {
  const tail = random
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);

  return `${slug(appName, 30 - "-ws-".length - tail.length)}-ws-${tail}`;
}

/** The docker run flags that let the container impersonate the account. */
export function impersonationFlags(email: string): string {
  return `-v "$HOME/.config/gcloud/application_default_credentials.json:/home/node/.config/gcloud/application_default_credentials.json:ro" -e GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=${email}`;
}

export type SetupStepId =
  | "addon"
  | "apis"
  | "customer"
  | "drive"
  | "identity"
  | "picker"
  | "project"
  | "role"
  | "tests";

export const SETUP_STEP_ORDER: readonly SetupStepId[] = [
  "project",
  "apis",
  "identity",
  "picker",
  "customer",
  "role",
  "drive",
  "addon",
  "tests",
];

export const SETUP_STEP_TITLES: Record<SetupStepId, string> = {
  addon: "Deploy the Gmail and Drive add-on and install it for you",
  apis: "Turn on the Google APIs",
  customer: "Read the Workspace customer ID",
  drive: "Create the Shared Drive for executed copies",
  identity: "Give the site its own Google identity",
  picker: "Create the Picker's API key",
  project: "Use the Cloud project",
  role: "Let the service account read the directory",
  tests: "Test it with this site's own access",
};

/** The id of the "make a new project" choice; no project ID is this short. */
export const NEW_PROJECT_OPTION = "new";
