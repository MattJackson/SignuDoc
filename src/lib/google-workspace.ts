import { z } from "zod";

import { normalizeGroupAddress, readAdminGroup } from "./google-admin-group.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "./integration-settings.ts";
import {
  getGoogleCredentials,
  type GoogleCredentialsSource,
} from "./integrations/google/credentials.ts";
import {
  DirectoryError,
  describeDirectoryStatus,
  getDirectoryClientFor,
  readDirectoryConfig,
  type DirectoryAccessMode,
} from "./integrations/google/directory.ts";
import {
  GOOGLE_ISSUER,
  normalizeIssuer,
  readPasswordSignInPolicy,
  readSsoConfig,
  resolveWorkspaceDomains,
  ssoRedirectPath,
  ssoSetInEnvironment,
  type WorkspaceDomains,
} from "./auth/sso.ts";
import { getSettings } from "./settings.ts";
import { parseEmailDomainList } from "./signup-policy.ts";
import { readEnv, resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// The Google Workspace part of Settings and of onboarding: Google sign-in,
// the Workspace directory and the administrator group, each with where its
// value comes from (an environment variable wins, and is shown as fixed)
// and checks an administrator can run. Google Drive, on the same service
// account, is in google-drive.ts.

export type SettingSource = "default" | "env" | "none" | "settings";

export type GoogleWorkspaceView = {
  adminGroup: {
    group: string | null;
    problem?: string;
    source: SettingSource;
  };
  directory: {
    adminSubject: string | null;
    adminSubjectFromEnv: boolean;
    customer: string;
    customerFromEnv: boolean;
    enabled: boolean;
    enabledSource: SettingSource;
    mode: DirectoryAccessMode;
  };
  /** The OAuth client's redirect URI, from this site's own URL. */
  redirectUri: string | null;
  serviceAccount: {
    email: string | null;
    /** Why the service account could not be found, when it could not. */
    problem: string | null;
    source: GoogleCredentialsSource | null;
  };
  signIn: {
    clientId: string;
    /** A client secret is stored; it is never sent to the browser. */
    hasClientSecret: boolean;
    /** Google is the provider, or nothing is set yet. */
    google: boolean;
    issuer: string;
    name: string;
    passwordAllowedEmails: string[];
    passwordSignIn: boolean;
    passwordSource: SettingSource;
    /** Single sign-on is set up and working from these settings. */
    ready: boolean;
    source: "env" | "settings" | null;
    workspaceDomains: WorkspaceDomains;
  };
  signupRule: { domains: string[]; mode: string };
  siteUrl: string | null;
};

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

async function describeServiceAccount(): Promise<
  GoogleWorkspaceView["serviceAccount"]
> {
  let credentials;

  try {
    credentials = getGoogleCredentials();
  } catch (error) {
    return {
      email: null,
      problem:
        error instanceof Error ? error.message : "The key could not be read.",
      source: null,
    };
  }

  if (!credentials) {
    return {
      email: null,
      problem:
        "This site is not running on Google Cloud and has no GOOGLE_SERVICE_ACCOUNT_KEY.",
      source: null,
    };
  }

  try {
    return {
      email: await credentials.getServiceAccountEmail(),
      problem: null,
      source: credentials.source,
    };
  } catch (error) {
    return {
      email: null,
      problem:
        error instanceof Error
          ? error.message
          : "The service account could not be found.",
      source: credentials.source,
    };
  }
}

export async function getGoogleWorkspaceView(
  env: EnvSource = process.env,
  stored?: IntegrationSettings,
): Promise<GoogleWorkspaceView> {
  const values = stored ?? (await getIntegrationSettings(env));
  const settings = await getSettings(env);
  const signupDomains =
    settings.signupMode === "domains" ? settings.allowedEmailDomains : [];
  const fromEnv = ssoSetInEnvironment(env);
  const sso = readSsoConfig(env, values);
  const password = readPasswordSignInPolicy(env, values);
  const directory = readDirectoryConfig(env, values);
  const group = readAdminGroup(env, values);
  const url = siteUrl(env);
  const issuer = fromEnv
    ? (readEnv(env, "SSO_ISSUER") ?? "")
    : (values["sso.issuer"] ?? "");

  return {
    adminGroup: group,
    directory: {
      adminSubject: directory.adminSubject,
      adminSubjectFromEnv: Boolean(
        readEnv(env, "GOOGLE_WORKSPACE_ADMIN_SUBJECT"),
      ),
      customer: directory.customer,
      customerFromEnv: Boolean(readEnv(env, "GOOGLE_WORKSPACE_CUSTOMER_ID")),
      enabled: directory.enabled,
      enabledSource: directory.enabledSource,
      mode: directory.mode,
    },
    redirectUri: url ? `${url}${ssoRedirectPath()}` : null,
    serviceAccount: await describeServiceAccount(),
    signIn: {
      clientId: fromEnv
        ? (readEnv(env, "SSO_CLIENT_ID") ?? "")
        : (values["sso.clientId"] ?? ""),
      google: issuer === "" || normalizeIssuer(issuer) === GOOGLE_ISSUER,
      hasClientSecret: fromEnv
        ? Boolean(readEnv(env, "SSO_CLIENT_SECRET"))
        : Boolean(values["sso.clientSecret"]),
      issuer,
      name: sso?.name ?? values["sso.name"] ?? "",
      passwordAllowedEmails:
        password.source === "env"
          ? password.allowedEmails
          : (values["sso.passwordAllowedEmails"] ?? "")
              .split(/[\s,;]+/)
              .filter(Boolean),
      passwordSignIn: password.enabled,
      passwordSource: password.source,
      ready: sso !== null,
      source: fromEnv ? "env" : sso ? "settings" : null,
      workspaceDomains: resolveWorkspaceDomains({
        env,
        signupDomains,
        stored: values,
      }),
    },
    signupRule: {
      domains: settings.allowedEmailDomains,
      mode: settings.signupMode,
    },
    siteUrl: url,
  };
}

export class GoogleWorkspaceSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("Check the highlighted fields.");
    this.name = "GoogleWorkspaceSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

// Every field is optional: each part of the page saves its own fields.
// A field left out is left as it is; an empty one is cleared.
const settingsSchema = z.object({
  adminGroup: optionalText(320),
  adminSubject: optionalText(320),
  clientId: optionalText(400),
  // Never sent back to the browser, so empty means "keep the stored one".
  clientSecret: optionalText(400),
  customerId: optionalText(64),
  directoryEnabled: z.boolean().optional(),
  issuer: optionalText(400),
  name: optionalText(60),
  passwordAllowedEmails: optionalText(2000),
  passwordSignIn: z.boolean().optional(),
  removeClientSecret: z.boolean().optional(),
  workspaceDomains: optionalText(2000),
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates and saves what an administrator changed on the page. Fields an
 * environment variable fixes are ignored, since the stored value would not
 * be the one in use.
 */
export async function saveGoogleWorkspaceSettings(
  rawInput: unknown,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<GoogleWorkspaceView> {
  const parsed = settingsSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new GoogleWorkspaceSettingsError({ form: "Check what was entered." });
  }

  const input = parsed.data;
  const current = await getIntegrationSettings(env);
  const update: IntegrationSettingsUpdate = {};
  const errors: Record<string, string> = {};
  const ssoFromEnv = ssoSetInEnvironment(env);

  if (!ssoFromEnv) {
    if (input.issuer !== undefined) {
      const issuer = input.issuer === "" ? null : normalizeIssuer(input.issuer);

      if (input.issuer !== "" && !issuer) {
        errors.issuer =
          "Enter the provider's https:// address, such as https://accounts.google.com";
      } else {
        update["sso.issuer"] = issuer;
      }
    }

    if (input.clientId !== undefined) {
      update["sso.clientId"] = input.clientId || null;
    }

    if (input.removeClientSecret) {
      update["sso.clientSecret"] = null;
    } else if (input.clientSecret) {
      update["sso.clientSecret"] = input.clientSecret;
    }

    if (input.name !== undefined) {
      update["sso.name"] = input.name || null;
    }
  }

  if (!readEnv(env, "PASSWORD_SIGN_IN")) {
    if (input.passwordAllowedEmails !== undefined) {
      const addresses = input.passwordAllowedEmails
        .split(/[\s,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const invalid = addresses.filter((value) => !emailPattern.test(value));

      if (invalid.length > 0) {
        errors.passwordAllowedEmails = `Not an email address: ${invalid.slice(0, 3).join(", ")}`;
      } else {
        update["sso.passwordAllowedEmails"] = addresses.join(", ") || null;
      }
    }

    if (input.passwordSignIn !== undefined) {
      update["sso.passwordSignIn"] = input.passwordSignIn ? "on" : "off";
    }

    // Judged as the settings will be once this save is applied, so a clear
    // made in the same save counts. It runs whenever password sign-in ends
    // up off and something it depends on is being changed.
    const next = applyUpdate(current, update);

    if (
      next["sso.passwordSignIn"] === "off" &&
      PASSWORD_GUARD_KEYS.some((key) => key in update)
    ) {
      if (!readSsoConfig(env, next)) {
        errors.passwordSignIn =
          "Set up Google sign-in first. Password sign-in can only be turned off while single sign-on works.";
      }

      if (!(next["sso.passwordAllowedEmails"] ?? "").trim()) {
        errors.passwordAllowedEmails =
          "Keep at least one administrator's address here, as a way in if Google is unavailable.";
      }
    }
  }

  if (
    input.workspaceDomains !== undefined &&
    !readEnv(env, "GOOGLE_WORKSPACE_DOMAINS")
  ) {
    const { domains, invalid } = parseEmailDomainList(input.workspaceDomains);

    if (invalid.length > 0) {
      errors.workspaceDomains = `Not a domain: ${invalid.slice(0, 3).join(", ")}`;
    } else {
      update["google.workspaceDomains"] = domains.join(", ") || null;
    }
  }

  if (input.adminGroup !== undefined && !readEnv(env, "GOOGLE_ADMIN_GROUP")) {
    const group = input.adminGroup
      ? normalizeGroupAddress(input.adminGroup)
      : null;

    if (input.adminGroup && !group) {
      errors.adminGroup =
        "Enter the group's email address, such as signudoc-admins@yourcompany.com";
    } else {
      update["google.adminGroup"] = group;
    }
  }

  if (
    input.adminSubject !== undefined &&
    !readEnv(env, "GOOGLE_WORKSPACE_ADMIN_SUBJECT")
  ) {
    if (input.adminSubject && !emailPattern.test(input.adminSubject)) {
      errors.adminSubject =
        "Enter an administrator's email address, or leave this empty";
    } else {
      update["google.adminSubject"] = input.adminSubject.toLowerCase() || null;
    }
  }

  if (
    input.customerId !== undefined &&
    !readEnv(env, "GOOGLE_WORKSPACE_CUSTOMER_ID")
  ) {
    if (input.customerId && !/^[A-Za-z0-9_]+$/.test(input.customerId)) {
      errors.customerId =
        "A customer ID is letters and digits, such as C01ab2cd3";
    } else {
      update["google.customerId"] = input.customerId || null;
    }
  }

  if (
    input.directoryEnabled !== undefined &&
    !readEnv(env, "GOOGLE_WORKSPACE_DIRECTORY")
  ) {
    update["google.directory"] = input.directoryEnabled ? "on" : "off";
  }

  if (Object.keys(errors).length > 0) {
    throw new GoogleWorkspaceSettingsError(errors);
  }

  const saved = await saveIntegrationSettings(update, actor, {
    area: "google_workspace",
    env,
  });

  return getGoogleWorkspaceView(env, saved);
}

const PASSWORD_GUARD_KEYS = [
  "sso.passwordSignIn",
  "sso.passwordAllowedEmails",
  "sso.clientSecret",
  "sso.issuer",
  "sso.clientId",
] as const;

/** The settings as they will be stored once the update is applied. */
function applyUpdate(
  current: IntegrationSettings,
  update: IntegrationSettingsUpdate,
): IntegrationSettings {
  const result: IntegrationSettings = { ...current };

  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "string" && value.trim() !== "") {
      result[key as keyof IntegrationSettings] = value;
    } else {
      delete result[key as keyof IntegrationSettings];
    }
  }

  return result;
}

export type DirectoryTestResult =
  | { message: string; ok: false; status: number | null }
  | { ok: true; people: { email: string; name: string }[] };

export type GroupTestResult =
  | { message: string; ok: false; status: number | null }
  | {
      group: string;
      groups: string[];
      isMember: boolean;
      ok: true;
    };

async function directoryForTest(env: EnvSource) {
  const stored = await getIntegrationSettings(env);
  const config = readDirectoryConfig(env, stored);

  // A malformed key throws here; the test reports it like any other
  // failure.
  let credentials: ReturnType<typeof getGoogleCredentials> = null;
  let error: unknown;

  try {
    credentials = getGoogleCredentials();
  } catch (caught) {
    error = caught;
  }

  return { config, credentials, error, stored };
}

function failed(error: unknown) {
  if (error instanceof DirectoryError) {
    return { message: error.message, ok: false as const, status: error.status };
  }

  return {
    message:
      error instanceof Error
        ? error.message
        : "The directory could not be read.",
    ok: false as const,
    status: null,
  };
}

/**
 * Looks the administrator up in the directory, through the same access the
 * app would use, whether or not suggestions are turned on yet.
 */
export async function testDirectoryAccess(
  adminEmail: string,
  env: EnvSource = process.env,
): Promise<DirectoryTestResult> {
  const { config, credentials, error } = await directoryForTest(env);

  if (error) {
    return failed(error);
  }

  if (!credentials) {
    return {
      message:
        "No Google credentials: run on Google Cloud, or set GOOGLE_SERVICE_ACCOUNT_KEY.",
      ok: false,
      status: null,
    };
  }

  try {
    const people = await getDirectoryClientFor(config, credentials).searchUsers(
      adminEmail,
      3,
    );

    if (people.length === 0) {
      return {
        message: `The directory answered, but did not list ${adminEmail}. Check that this site's sign-up domains are the Workspace's and that the account is active.`,
        ok: false,
        status: 200,
      };
    }

    return { ok: true, people };
  } catch (error) {
    return failed(error);
  }
}

/** Checks the administrator group against the administrator's own account. */
export async function testGroupLookup(
  adminEmail: string,
  groupInput: string | null,
  env: EnvSource = process.env,
): Promise<GroupTestResult> {
  const { config, credentials, error, stored } = await directoryForTest(env);
  const group = groupInput
    ? normalizeGroupAddress(groupInput)
    : readAdminGroup(env, stored).group;

  if (!group) {
    return {
      message: "Enter the group's email address first.",
      ok: false,
      status: null,
    };
  }

  if (error) {
    return failed(error);
  }

  if (!credentials) {
    return {
      message: describeDirectoryStatus(null),
      ok: false,
      status: null,
    };
  }

  try {
    const client = getDirectoryClientFor(config, credentials);
    const [isMember, groups] = await Promise.all([
      client.isGroupMember(group, adminEmail),
      client.listUserGroups(adminEmail),
    ]);

    return {
      group,
      groups: groups.map((item) => item.email),
      isMember,
      ok: true,
    };
  } catch (error) {
    return failed(error);
  }
}
