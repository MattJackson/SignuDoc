import { readEnv, type EnvSource } from "../../../utils/env.ts";

// What the Google Workspace add-on needs to know to trust a request, and
// where each value comes from. Both come from Google once the add-on is
// deployed (`gcloud workspace-add-ons get-authorization`):
//
// - the add-on's service account, the `email` in the system ID token Google
//   sends with every request. Its address looks like
//   service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com.
// - the add-on's OAuth client ID, the audience of the user ID token that
//   names the person using it.
//
// Each is set in Settings, Google Workspace, or with an environment
// variable, which wins. The add-on answers nothing until both are set, so a
// site that never deploys one has nothing to attack here.

export const ADDON_ENDPOINT_BASE_PATH = "/api/google/addon";

export const ADDON_TRIGGERS = [
  "homepage",
  "gmail-message",
  "drive-items",
  "action",
] as const;

export type AddonTrigger = (typeof ADDON_TRIGGERS)[number];

export function isAddonTrigger(value: unknown): value is AddonTrigger {
  return (ADDON_TRIGGERS as readonly unknown[]).includes(value);
}

export type StoredAddonSettings = Readonly<
  Partial<Record<"google.addonClientId" | "google.addonServiceAccount", string>>
>;

export type AddonSettingSource = "env" | "none" | "settings";

export type AddonConfig = {
  /** Extra audiences accepted for the system ID token, from the environment. */
  extraAudiences: string[];
  oauthClientId: string | null;
  oauthClientIdSource: AddonSettingSource;
  /** Both values are there, so requests can be checked and answered. */
  ready: boolean;
  serviceAccountEmail: string | null;
  serviceAccountSource: AddonSettingSource;
};

const serviceAccountPattern =
  /^[a-z0-9][a-z0-9-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.iam\.gserviceaccount\.com$/;
const clientIdPattern = /^[0-9A-Za-z_.-]{6,200}$/;

/** A service account's address, lowercased, or null when it is not one. */
export function normalizeServiceAccountEmail(value: string): string | null {
  const email = value.trim().toLowerCase();

  return serviceAccountPattern.test(email) ? email : null;
}

/** An OAuth client ID, or null when it is not one. */
export function normalizeOAuthClientId(value: string): string | null {
  const id = value.trim();

  return clientIdPattern.test(id) ? id : null;
}

function pick(
  env: EnvSource,
  variable: string,
  stored: string | undefined,
  normalize: (value: string) => string | null,
): { source: AddonSettingSource; value: string | null } {
  const fromEnv = readEnv(env, variable);

  if (fromEnv) {
    return { source: "env", value: normalize(fromEnv) };
  }

  const fromSettings = stored?.trim() ? normalize(stored) : null;

  return fromSettings
    ? { source: "settings", value: fromSettings }
    : { source: "none", value: null };
}

export function readAddonConfig(
  env: EnvSource = process.env,
  stored: StoredAddonSettings | null = null,
): AddonConfig {
  const serviceAccount = pick(
    env,
    "GOOGLE_ADDON_SERVICE_ACCOUNT",
    stored?.["google.addonServiceAccount"],
    normalizeServiceAccountEmail,
  );
  const clientId = pick(
    env,
    "GOOGLE_ADDON_CLIENT_ID",
    stored?.["google.addonClientId"],
    normalizeOAuthClientId,
  );
  const extraAudiences = (readEnv(env, "GOOGLE_ADDON_AUDIENCE") ?? "")
    .split(/[\s,]+/)
    .filter((value) => value.startsWith("https://"));

  return {
    extraAudiences,
    oauthClientId: clientId.value,
    oauthClientIdSource: clientId.source,
    ready: serviceAccount.value !== null && clientId.value !== null,
    serviceAccountEmail: serviceAccount.value,
    serviceAccountSource: serviceAccount.source,
  };
}

/** The URL Google calls for one trigger, from this site's own address. */
export function addonEndpointUrl(siteUrl: string, trigger: AddonTrigger) {
  return `${siteUrl.replace(/\/+$/, "")}${ADDON_ENDPOINT_BASE_PATH}/${trigger}`;
}
