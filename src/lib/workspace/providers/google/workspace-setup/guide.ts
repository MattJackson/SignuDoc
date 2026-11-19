import type { EnvSource } from "../../../../utils/env.ts";
import {
  resolveWorkspaceSetting,
  WORKSPACE_SETTINGS,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from "../../../settings.ts";
import type {
  WorkspaceGuideField,
  WorkspaceGuideStep,
  WorkspaceSetupGuide,
  WorkspaceSetupSite,
} from "../../../types.ts";
import {
  normalizeOAuthClientId,
  normalizeServiceAccountEmail,
  readAddonConfig,
} from "../addon/config.ts";
import {
  ADDON_OAUTH_SCOPES,
  DEFAULT_DEPLOYMENT_ID,
} from "../addon/manifest.ts";
import {
  googleCredentialsFor,
  readGoogleProjectId,
  readGoogleProjectNumber,
  type GoogleCredentials,
} from "../credentials.ts";
import { needsCustomerId, readGoogleDirectoryConfig } from "../directory.ts";
import { extractDriveId, readPickerConfig } from "../drive/drive-config.ts";
import { readDriveOAuthClient } from "../drive/drive-oauth.ts";
import {
  ADMIN_ACCOUNT_SETTINGS_URL,
  ADMIN_ROLES_URL,
  apiLibraryUrl,
  consoleUrl,
  googleProjectId,
  MARKETPLACE_CONFIG_PATH,
  originOf,
  SHARED_DRIVES_URL,
} from "./console.ts";
import {
  directoryRoleName,
  executedDriveName,
  impersonationFlags,
  pickerKeyName,
  SETUP_APIS,
  workspaceAccountEmail,
  workspaceAccountId,
} from "./names.ts";

// The manual Google Workspace setup, step by step (WorkspaceSetupGuide in
// ../../../types.ts): for each step a link into the right console, this
// site's own values to copy, a field to paste Google's value into where
// one is needed, and the check that tests it. The automatic setup
// (automatic.ts) does the same steps with one sign-in.

/** The guide's fields, and the value each one takes. */
const FIELD_RULES: Partial<
  Record<
    WorkspaceSettingKey,
    (value: string) => { error: string } | { value: string }
  >
> = {
  "files.exportDestination": (value) => {
    const id = extractDriveId(value);

    return id
      ? { value: id }
      : { error: "Paste the Shared Drive's address or its ID." };
  },
  "google.addonClientId": (value) => {
    const id = normalizeOAuthClientId(value);

    return id
      ? { value: id }
      : { error: "Enter the OAuth client ID that Google showed." };
  },
  "google.addonServiceAccount": (value) => {
    const email = normalizeServiceAccountEmail(value);

    return email
      ? { value: email }
      : {
          error:
            "Enter the service account's address, ending in .iam.gserviceaccount.com",
        };
  },
  "google.customerId": (value) =>
    /^[A-Za-z0-9_]{1,64}$/.test(value)
      ? { value }
      : { error: "A customer ID is letters and digits, such as C01ab2cd3" },
  "google.pickerApiKey": (value) =>
    /^[A-Za-z0-9_-]{20,100}$/.test(value)
      ? { value }
      : { error: "Paste the API key, which starts with AIza." },
  "google.pickerAppId": (value) =>
    /^\d{6,20}$/.test(value)
      ? { value }
      : { error: "The project number is digits only." },
};

/** The value to save for one of the guide's fields, or why not. */
export function normalizeGoogleGuideValue(
  setting: WorkspaceSettingKey,
  value: string,
): { error: string } | { value: string } {
  const rule = FIELD_RULES[setting];

  return rule
    ? rule(value.trim())
    : { error: "This setting is saved in its own section." };
}

function field(
  setting: WorkspaceSettingKey,
  label: string,
  stored: WorkspaceSettings,
  env: EnvSource,
  placeholder?: string,
): WorkspaceGuideField {
  return {
    ...resolveWorkspaceSetting(setting, stored, env),
    env: WORKSPACE_SETTINGS[setting].env,
    label,
    ...(placeholder ? { placeholder } : {}),
    setting,
  };
}

function step(
  input: Partial<WorkspaceGuideStep> &
    Pick<WorkspaceGuideStep, "id" | "instructions" | "title">,
): WorkspaceGuideStep {
  return {
    check: null,
    done: null,
    fields: [],
    links: [],
    optional: false,
    values: [],
    ...input,
  };
}

export async function buildGoogleGuide({
  env = process.env,
  getCredentials,
  settings,
  site,
}: {
  env?: EnvSource;
  getCredentials?: () => GoogleCredentials | null;
  settings: WorkspaceSettings;
  site: WorkspaceSetupSite;
}): Promise<WorkspaceSetupGuide> {
  let identity: string | null = null;

  try {
    const credentials = (getCredentials ?? (() => googleCredentialsFor(env)))();

    identity = credentials ? await credentials.getServiceAccountEmail() : null;
  } catch {
    // The identity step says how to give the site one.
  }

  const runningIn = await readGoogleProjectId({ env });
  const project =
    resolveWorkspaceSetting("google.cloudProject", settings, env).value ??
    runningIn ??
    googleProjectId(identity);
  const picker = readPickerConfig(settings, env);
  const projectNumber =
    picker.appId ??
    (runningIn && project === runningIn
      ? await readGoogleProjectNumber({ env })
      : null);
  const origin = originOf(site.url);
  const ownAccount = project ? workspaceAccountEmail(site.name, project) : null;
  const account = identity ?? ownAccount;
  const accountLabel = account ?? "the site's service account";
  const addon = readAddonConfig(env, settings);
  const exportDestination = resolveWorkspaceSetting(
    "files.exportDestination",
    settings,
    env,
  ).value;

  const steps: WorkspaceGuideStep[] = [
    step({
      done: readDriveOAuthClient(env) !== null,
      id: "client",
      instructions: [
        "Google has no API for the consent screen and the OAuth client, so these are done by hand, once.",
        "Open Google Auth Platform, choose Get started, enter the app name, pick your support address and choose Internal as the audience.",
        "Create an OAuth client: Web application, with the JavaScript origin and the redirect URIs below.",
        "Set its ID and secret where the site runs as GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET. The secret is never kept in the database. With Google as the single sign-on provider (SSO_ISSUER=https://accounts.google.com) its client is used, so add the redirect URIs to that one instead.",
      ],
      links: [
        {
          href: consoleUrl("/auth/overview", project),
          label: "Google Auth Platform",
        },
        {
          href: consoleUrl("/auth/clients/create", project),
          label: "Create an OAuth client",
        },
      ],
      title: "Create the consent screen and the OAuth client",
      values: [
        { label: "App name", value: site.name },
        ...(origin
          ? [
              {
                hint: "Under Authorized JavaScript origins.",
                label: "JavaScript origin",
                value: origin,
              },
            ]
          : []),
        ...(site.callbacks.signIn
          ? [
              {
                hint: "Authorized redirect URI: Google single sign-on.",
                label: "Sign-in redirect URI",
                value: site.callbacks.signIn,
              },
            ]
          : []),
        ...(site.callbacks.files
          ? [
              {
                hint: "Authorized redirect URI: connecting Google Drive.",
                label: "Drive redirect URI",
                value: site.callbacks.files,
              },
            ]
          : []),
        ...(site.callbacks.setup
          ? [
              {
                hint: "Authorized redirect URI: the automatic setup.",
                label: "Setup redirect URI",
                value: site.callbacks.setup,
              },
            ]
          : []),
      ],
    }),
    step({
      id: "apis",
      instructions: [
        "Open each API and choose Enable. One that is on already says Manage. None of them needs billing.",
      ],
      links: SETUP_APIS.map((api) => ({
        href: apiLibraryUrl(api, project),
        label: api,
      })),
      title: "Turn on the Google APIs",
    }),
    step({
      check: "identity",
      done: identity !== null,
      id: "identity",
      instructions: identity
        ? [`The site already acts as ${identity}.`]
        : [
            "On Google Cloud (Cloud Run, GKE, Compute Engine) the site uses the service account it runs as, and there is nothing to do.",
            "Elsewhere, create a service account with the ID below. This site keeps no keys in its database, so give it the account where it runs, in one of two ways:",
            "With a key: on the account's Keys tab choose Add key, JSON, and set GOOGLE_SERVICE_ACCOUNT_KEY to the file (or the same in base64).",
            "Without a key, where your organization forbids them: give yourself Service Account Token Creator on the account (its Permissions tab), run gcloud auth application-default login, and start the site with the flags below.",
          ],
      links: [
        {
          href: consoleUrl("/iam-admin/serviceaccounts/create", project),
          label: "Create a service account",
        },
        {
          href: consoleUrl("/iam-admin/serviceaccounts", project),
          label: "Service accounts (keys and permissions)",
        },
      ],
      title: "Give the site its own Google identity",
      values: identity
        ? [{ label: "Service account", value: identity }]
        : [
            {
              label: "Service account ID",
              value: workspaceAccountId(site.name),
            },
            ...(ownAccount
              ? [
                  {
                    hint: "docker run flags, for impersonation.",
                    label: "Impersonation",
                    value: impersonationFlags(ownAccount),
                  },
                ]
              : []),
          ],
    }),
    step({
      check: "files",
      done: picker.ready,
      fields: [
        field(
          "google.pickerApiKey",
          "Picker API key",
          settings,
          env,
          "AIza...",
        ),
        field(
          "google.pickerAppId",
          "Project number",
          settings,
          env,
          "123456789012",
        ),
      ],
      id: "picker",
      instructions: [
        "Open Credentials, choose Create credentials, API key. Name it as below, restrict it to Websites with this site, and to the Google Picker API only.",
        "Paste the key and the Cloud project's number (on the project's dashboard) here. Neither is secret: the browser gets both.",
      ],
      links: [
        {
          href: consoleUrl("/apis/credentials", project),
          label: "Credentials",
        },
      ],
      optional: true,
      title: "Create the Picker's API key",
      values: [
        { label: "Key name", value: pickerKeyName(site.name) },
        ...(origin
          ? [{ label: "Website restriction", value: `${origin}/*` }]
          : []),
        ...(projectNumber
          ? [{ label: "Project number", value: projectNumber }]
          : []),
      ],
    }),
    step({
      done: !needsCustomerId(readGoogleDirectoryConfig(settings, env)),
      fields: [
        field("google.customerId", "Customer ID", settings, env, "C01ab2cd3"),
      ],
      id: "customer",
      instructions: [
        "It is under Admin console, Account, Account settings, and starts with C.",
      ],
      links: [
        {
          href: ADMIN_ACCOUNT_SETTINGS_URL,
          label: "Admin console, Account settings",
        },
      ],
      title: "Paste the Workspace customer ID",
    }),
    step({
      check: "directory",
      id: "role",
      instructions: [
        "Open Admin console, Account, Admin roles, choose Create new role and enter the name below.",
        "Under Admin API privileges tick Users, Read and Groups, Read. Nothing else.",
        `Open the role, choose Assign service accounts and enter ${accountLabel}.`,
        "Then turn the directory on in Settings, Workspace.",
      ],
      links: [{ href: ADMIN_ROLES_URL, label: "Admin console, Admin roles" }],
      title: "Let the service account read the directory",
      values: [
        { label: "Role name", value: directoryRoleName(site.name) },
        ...(account ? [{ label: "Service account", value: account }] : []),
      ],
    }),
    step({
      check: "files",
      done: exportDestination ? true : null,
      fields: [
        field(
          "files.exportDestination",
          "Shared Drive address or ID",
          settings,
          env,
          "https://drive.google.com/drive/folders/0A...",
        ),
      ],
      id: "drive",
      instructions: [
        `Open Shared drives, create one named as below, choose Manage members and add ${accountLabel} as Content manager.`,
        "Then paste the drive's address or ID here.",
      ],
      links: [{ href: SHARED_DRIVES_URL, label: "Shared drives" }],
      optional: true,
      title: "Create the Shared Drive for executed copies",
      values: [
        { label: "Shared Drive name", value: executedDriveName(site.name) },
        ...(account
          ? [{ label: "Member (Content manager)", value: account }]
          : []),
      ],
    }),
    step({
      check: "addIn",
      done: addon.ready,
      fields: [
        field(
          "google.addonServiceAccount",
          "The add-on's service account",
          settings,
          env,
          "service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
        ),
        field(
          "google.addonClientId",
          "The add-on's OAuth client ID",
          settings,
          env,
        ),
      ],
      id: "addon",
      instructions: [
        "Deploy the add-on from Settings, Add-in for Google Workspace: download the deployment file and run the gcloud commands there. It needs a public HTTPS address.",
        "gcloud workspace-add-ons get-authorization shows the add-on's service account and OAuth client ID. Paste both here.",
        "For everyone in the domain, open App configuration: visibility Private, installation Admin only, app integration Google Workspace add-on with the deployment ID and scopes below. Publish the store listing, then install it for the domain from the Admin console (Apps, Google Workspace Marketplace apps).",
      ],
      links: [
        {
          href: consoleUrl(MARKETPLACE_CONFIG_PATH, project),
          label: "Marketplace SDK, App configuration",
        },
      ],
      optional: true,
      title: "Deploy the Gmail and Drive add-on",
      values: [
        { label: "Deployment ID", value: DEFAULT_DEPLOYMENT_ID },
        { label: "OAuth scopes", value: ADDON_OAUTH_SCOPES.join(",") },
      ],
    }),
  ];

  return {
    intro: `Each step opens the right page of Google's consoles${project ? ` in ${project}` : ""}, with this site's values to copy, a field for Google's value where one is needed, and a test. Run them in order; what is in place already is marked.`,
    steps,
  };
}
