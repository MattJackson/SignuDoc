// The names, steps and events of the automatic Google Workspace setup
// (workspace-setup.ts), with nothing that needs the server, so the setup
// page in the browser shows the same names the server uses.

/** Where Google sends the administrator back to: add it to the OAuth client. */
export const SETUP_CALLBACK_PATH = "/settings/google-setup";

/** Where Google sends someone back to after connecting Google Drive. */
export const DRIVE_CALLBACK_PATH = "/api/google/drive/callback";

/** Where Google sends someone back to after signing in (Better Auth's). */
export const SSO_CALLBACK_PATH = "/api/auth/callback/sso";

/** The APIs the app calls, turned on in step a. None of them needs billing. */
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

/** The add-on's deployment ID in the Cloud project, for the Marketplace too. */
export const ADDON_DEPLOYMENT_ID = "signudoc";

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

/** The name of the Cloud project the setup can make: "<App> Workspace". */
export function workspaceProjectName(appName: string): string {
  // Project names allow letters, digits, spaces, quotes, hyphens and
  // exclamation marks, 4 to 30 characters.
  const name = `${
    appName
      .replace(/[^A-Za-z0-9 '"!-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20)
      .trim() || "SignuDoc"
  } Workspace`;

  return name;
}

/** A new project's ID: the app's name and a few random letters, 6 to 30. */
export function workspaceProjectId(appName: string, random: string): string {
  const tail = random
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);

  return `${slug(appName, 30 - "-ws-".length - tail.length)}-ws-${tail}`;
}

export type GoogleIdentitySource =
  "impersonation" | "metadata" | "service-account-key" | "stored-key";

/** Which Google identity the app uses, in one sentence for the pages. */
export function identitySentence(
  identity: { email: string; source: GoogleIdentitySource } | null,
): string {
  if (!identity) {
    return "This site has no Google identity yet. The automatic setup makes one; on Cloud Run it uses the service account the site runs as.";
  }

  switch (identity.source) {
    case "metadata":
      return `Runs on Google Cloud as ${identity.email}, with no key stored.`;
    case "service-account-key":
      return `Uses the key in GOOGLE_SERVICE_ACCOUNT_KEY for ${identity.email}.`;
    case "stored-key":
      return `Uses the stored key for ${identity.email}.`;
    case "impersonation":
      return `Impersonates ${identity.email} with your gcloud login.`;
  }
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

export type SetupStepStatus = "done" | "failed" | "running" | "skipped";

/** A Cloud project the administrator can choose for the setup. */
export type SetupProject = {
  name: string;
  /** The project number, which the Picker uses as its app ID. */
  number: string | null;
  projectId: string;
};

/** What the administrator chose: a project, or a new one. */
export type SetupProjectChoice =
  { create: true } | { create: false; projectId: string };

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
  | {
      /** The name a new project would get. */
      newProjectName: string;
      /** The organization a new project goes in, when one was found. */
      organization: string | null;
      /** The project to offer first, when there is a reason to. */
      preselected: string | null;
      projects: SetupProject[];
      /** Why it is preselected, such as "This site runs in it." */
      reason: string | null;
      /** Names this run when the choice is sent back. */
      runId: string;
      type: "choose";
      /** How long the run waits for the choice. */
      waitSeconds: number;
    }
  | { type: "waiting" }
  | { hint?: string; message: string; type: "refused" }
  | { ok: boolean; revoked: boolean; type: "finished" };

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
