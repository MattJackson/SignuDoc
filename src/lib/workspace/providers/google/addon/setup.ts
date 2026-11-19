import type { EnvSource } from "../../../../utils/env.ts";
import { addInAddressProblem, addInSiteUrl } from "../../../add-in-support.ts";
import type { WorkspaceSettings } from "../../../settings.ts";
import type {
  WorkspaceAddInDeployment,
  WorkspaceAddInSite,
  WorkspaceCheck,
} from "../../../types.ts";
import { readAddonConfig } from "./config.ts";
import { createJwksCache, IdTokenError } from "./id-token.ts";
import {
  buildAddonDeployment,
  DEPLOYMENT_FILE_NAME,
  deploymentCommands,
} from "./manifest.ts";

// The add-on's part of Settings: the deployment JSON with this site's
// URLs, the commands that deploy and install it, the two values from
// Google that let the site trust its requests, and the checks.

export function describeAddonDeployment({
  env = process.env,
  settings = null,
  site,
}: {
  env?: EnvSource;
  settings?: WorkspaceSettings | null;
  site: WorkspaceAddInSite;
}): WorkspaceAddInDeployment {
  const config = readAddonConfig(env, settings);
  const siteUrl = site.url ?? addInSiteUrl(env);
  const deployment = siteUrl
    ? buildAddonDeployment({
        brandColor: site.brandColor,
        name: site.name ? `${site.name} SignuDoc` : null,
        siteUrl,
      })
    : null;

  return {
    file: deployment
      ? {
          content: `${JSON.stringify(deployment, null, 2)}\n`,
          name: DEPLOYMENT_FILE_NAME,
        }
      : null,
    problem: addInAddressProblem(siteUrl),
    ready: config.ready,
    steps: deploymentCommands().map((entry) => ({
      command: entry.command,
      text: entry.purpose,
    })),
    values: [
      {
        env: "GOOGLE_ADDON_SERVICE_ACCOUNT",
        label: "The add-on's service account",
        setting: "google.addonServiceAccount",
        source: config.serviceAccountSource,
        value: config.serviceAccountEmail,
      },
      {
        env: "GOOGLE_ADDON_CLIENT_ID",
        label: "The add-on's OAuth client ID",
        setting: "google.addonClientId",
        source: config.oauthClientIdSource,
        value: config.oauthClientId,
      },
    ],
  };
}

async function checkGoogleKeys(
  fetchImpl: typeof fetch,
): Promise<WorkspaceCheck> {
  const name = "Google's signing keys";

  try {
    // A key id Google never had: the set is read, and nothing matches.
    await createJwksCache({ fetchImpl }).getKey("signudoc-check");

    return {
      id: "addIn.keys",
      message: "Google's signing keys can be read.",
      name,
      ok: true,
    };
  } catch (error) {
    return {
      id: "addIn.keys",
      message:
        error instanceof IdTokenError
          ? error.message
          : "Google's signing keys could not be read.",
      name,
      ok: false,
    };
  }
}

/**
 * Whether the add-on can answer: its values, the address, and, once both
 * values are set, whether Google's signing keys can be read.
 */
export async function checkGoogleAddon({
  env = process.env,
  fetchImpl = fetch,
  settings = null,
}: {
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  settings?: WorkspaceSettings | null;
}): Promise<WorkspaceCheck[]> {
  const config = readAddonConfig(env, settings);
  const missing = [
    config.serviceAccountEmail ? null : "GOOGLE_ADDON_SERVICE_ACCOUNT",
    config.oauthClientId ? null : "GOOGLE_ADDON_CLIENT_ID",
  ].filter((name): name is string => name !== null);
  const problem = addInAddressProblem(addInSiteUrl(env));
  const checks: WorkspaceCheck[] = [
    {
      id: "addIn.values",
      message:
        missing.length === 0
          ? `Requests from ${config.serviceAccountEmail ?? ""} are answered.`
          : `Set ${missing.join(" and ")}, with the values gcloud workspace-add-ons get-authorization shows. A value that is set but not valid counts as missing.`,
      name: "The add-on's service account and client ID",
      ok: missing.length === 0,
    },
    {
      id: "addIn.address",
      message: problem ?? "Google can call the add-on at this site's address.",
      name: "This site's address",
      ok: problem === null,
    },
  ];

  return config.ready ? [...checks, await checkGoogleKeys(fetchImpl)] : checks;
}
