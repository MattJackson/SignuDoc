import { readEnv, type EnvSource } from "../../../../utils/env.ts";
import {
  resolveWorkspaceSetting,
  type ResolvedWorkspaceSetting,
  type WorkspaceSettings,
} from "../../../settings.ts";

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
// Each is a workspace setting (google.addonServiceAccount,
// google.addonClientId) or an environment variable, which wins. The add-on
// answers nothing until both are set, so a site that never deploys one has
// nothing to attack here.

/** The add-on's actions: one URL each, under /api/workspace/add-in. */
export const ADDON_ACTIONS = [
  "homepage",
  "gmail-message",
  "drive-items",
  "action",
] as const;

export type AddonAction = (typeof ADDON_ACTIONS)[number];

export function isAddonAction(value: unknown): value is AddonAction {
  return (ADDON_ACTIONS as readonly unknown[]).includes(value);
}

export type AddonSettingSource = ResolvedWorkspaceSetting["source"];

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

export function readAddonConfig(
  env: EnvSource = process.env,
  stored: WorkspaceSettings | null = null,
): AddonConfig {
  const serviceAccount = resolveWorkspaceSetting(
    "google.addonServiceAccount",
    stored,
    env,
  );
  const clientId = resolveWorkspaceSetting("google.addonClientId", stored, env);
  const serviceAccountEmail = serviceAccount.value
    ? normalizeServiceAccountEmail(serviceAccount.value)
    : null;
  const oauthClientId = clientId.value
    ? normalizeOAuthClientId(clientId.value)
    : null;
  // A proxy in front of the site may make Google call another address;
  // its URLs are accepted as the system ID token's audience too.
  const extraAudiences = (readEnv(env, "GOOGLE_ADDON_AUDIENCE") ?? "")
    .split(/[\s,]+/)
    .filter((value) => value.startsWith("https://"));

  return {
    extraAudiences,
    oauthClientId,
    oauthClientIdSource: clientId.source,
    ready: serviceAccountEmail !== null && oauthClientId !== null,
    serviceAccountEmail,
    serviceAccountSource: serviceAccount.source,
  };
}
