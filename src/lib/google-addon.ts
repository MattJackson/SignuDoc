import { z } from "zod";

import { resolveWorkspaceDomains } from "./auth/sso.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "./integration-settings.ts";
import {
  ADDON_TRIGGERS,
  addonEndpointUrl,
  normalizeOAuthClientId,
  normalizeServiceAccountEmail,
  readAddonConfig,
  type AddonConfig,
  type AddonSettingSource,
} from "./integrations/google/addon/config.ts";
import {
  ADDON_OAUTH_SCOPES,
  buildAddonDeployment,
  deploymentCommands,
  type AddonDeployment,
} from "./integrations/google/addon/manifest.ts";
import { getSettings } from "./settings.ts";
import { readEnv, resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// The Google Workspace add-on's part of Settings and of onboarding: the
// deployment JSON with this site's URLs, the commands that deploy and
// install it, and the two values from Google that let the site trust the
// add-on's requests. Saved like the other Google settings
// (integration-settings.ts); an environment variable that is set wins.

export type GoogleAddonView = {
  clientId: { source: AddonSettingSource; value: string | null };
  commands: { command: string; purpose: string }[];
  /** Null when this site does not know its own address yet. */
  deployment: AddonDeployment | null;
  endpoints: { trigger: string; url: string }[];
  ready: boolean;
  scopes: string[];
  serviceAccount: { source: AddonSettingSource; value: string | null };
  siteUrl: string | null;
};

export function addonSiteUrl(env: EnvSource = process.env): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

export async function readStoredAddonConfig(
  env: EnvSource = process.env,
): Promise<AddonConfig> {
  return readAddonConfig(env, await getIntegrationSettings(env));
}

/** The Workspace domains the add-on's users must be in, as for sign-in. */
export async function addonWorkspaceDomains(
  env: EnvSource = process.env,
): Promise<string[]> {
  const [settings, stored] = await Promise.all([
    getSettings(env),
    getIntegrationSettings(env),
  ]);

  return resolveWorkspaceDomains({
    env,
    signupDomains:
      settings.signupMode === "domains" ? settings.allowedEmailDomains : [],
    stored,
  }).domains;
}

export async function getGoogleAddonView(
  env: EnvSource = process.env,
  stored?: IntegrationSettings,
): Promise<GoogleAddonView> {
  const values = stored ?? (await getIntegrationSettings(env));
  const config = readAddonConfig(env, values);
  const siteUrl = addonSiteUrl(env);
  const settings = await getSettings(env);

  return {
    clientId: {
      source: config.oauthClientIdSource,
      value: config.oauthClientId,
    },
    commands: deploymentCommands(),
    deployment: siteUrl
      ? buildAddonDeployment({
          brandColor: settings.brandColor,
          name: settings.organizationName
            ? `${settings.organizationName} SignuDoc`
            : null,
          siteUrl,
        })
      : null,
    endpoints: siteUrl
      ? ADDON_TRIGGERS.map((trigger) => ({
          trigger,
          url: addonEndpointUrl(siteUrl, trigger),
        }))
      : [],
    ready: config.ready,
    scopes: [...ADDON_OAUTH_SCOPES],
    serviceAccount: {
      source: config.serviceAccountSource,
      value: config.serviceAccountEmail,
    },
    siteUrl,
  };
}

export class GoogleAddonSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("Check the highlighted fields.");
    this.name = "GoogleAddonSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

const settingsSchema = z.object({
  clientId: z.string().trim().max(200).optional(),
  serviceAccount: z.string().trim().max(320).optional(),
});

/** Saves the add-on's service account and client ID. Empty clears them. */
export async function saveGoogleAddonSettings(
  rawInput: unknown,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<GoogleAddonView> {
  const parsed = settingsSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new GoogleAddonSettingsError({ form: "Check what was entered." });
  }

  const input = parsed.data;
  const update: IntegrationSettingsUpdate = {};
  const errors: Record<string, string> = {};

  if (
    input.serviceAccount !== undefined &&
    !readEnv(env, "GOOGLE_ADDON_SERVICE_ACCOUNT")
  ) {
    const email = input.serviceAccount
      ? normalizeServiceAccountEmail(input.serviceAccount)
      : null;

    if (input.serviceAccount && !email) {
      errors.serviceAccount =
        "Enter the service account's address, ending in .iam.gserviceaccount.com";
    } else {
      update["google.addonServiceAccount"] = email;
    }
  }

  if (input.clientId !== undefined && !readEnv(env, "GOOGLE_ADDON_CLIENT_ID")) {
    const id = input.clientId ? normalizeOAuthClientId(input.clientId) : null;

    if (input.clientId && !id) {
      errors.clientId = "Enter the OAuth client ID that gcloud printed";
    } else {
      update["google.addonClientId"] = id;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new GoogleAddonSettingsError(errors);
  }

  const saved = await saveIntegrationSettings(update, actor, {
    area: "google_addon",
    env,
  });

  return getGoogleAddonView(env, saved);
}
