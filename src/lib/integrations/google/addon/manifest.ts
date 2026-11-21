import { addonEndpointUrl } from "./config.ts";

// The add-on's deployment, the JSON `gcloud workspace-add-ons deployments
// create` takes, with this site's own URLs. Its shape is Google's
// Deployment resource
// (https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.deployments):
// oauthScopes, and addOns with common (name, logo, homepage), gmail (a
// contextual trigger on every open message), drive (homepage and
// onItemsSelectedTrigger) and httpOptions.
//
// httpOptions.authorizationHeader is SYSTEM_ID_TOKEN: Google then sends an
// ID token for the add-on's service account in the Authorization header of
// every request, which verify-request.ts checks.
//
// The scopes are the fewest that do the job:
// - openid and userinfo.email: the user ID token, with the address the
//   account is found by;
// - gmail.addons.execute: to run in Gmail at all;
// - gmail.addons.current.message.readonly: to read the open message and
//   its attachments, and only that message;
// - drive.addons.metadata.readonly: the names and types of selected files;
// - drive.file: to open a file once the user gives it to the add-on, and
//   to convert a Word file through Drive.

export const ADDON_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.addons.execute",
  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
  "https://www.googleapis.com/auth/drive.addons.metadata.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export const DEFAULT_DEPLOYMENT_ID = "signudoc";

export type AddonDeployment = {
  addOns: {
    common: {
      homepageTrigger: { runFunction: string };
      layoutProperties: { primaryColor: string };
      logoUrl: string;
      name: string;
      openLinkUrlPrefixes: string[];
    };
    drive: {
      homepageTrigger: { runFunction: string };
      onItemsSelectedTrigger: { runFunction: string };
    };
    gmail: {
      contextualTriggers: {
        onTriggerFunction: string;
        unconditional: Record<string, never>;
      }[];
      homepageTrigger: { runFunction: string };
    };
    httpOptions: { authorizationHeader: "SYSTEM_ID_TOKEN" };
  };
  oauthScopes: string[];
};

export function buildAddonDeployment(input: {
  brandColor?: string | null;
  name?: string | null;
  siteUrl: string;
}): AddonDeployment {
  const siteUrl = input.siteUrl.replace(/\/+$/, "");
  const homepage = addonEndpointUrl(siteUrl, "homepage");

  return {
    addOns: {
      common: {
        homepageTrigger: { runFunction: homepage },
        layoutProperties: {
          primaryColor: input.brandColor?.trim() || "#1f4fd6",
        },
        logoUrl: `${siteUrl}/icon.svg`,
        name: (input.name?.trim() || "SignuDoc").slice(0, 40),
        // Cards may only open links on this site.
        openLinkUrlPrefixes: [`${siteUrl}/`],
      },
      drive: {
        homepageTrigger: { runFunction: homepage },
        onItemsSelectedTrigger: {
          runFunction: addonEndpointUrl(siteUrl, "drive-items"),
        },
      },
      gmail: {
        contextualTriggers: [
          {
            onTriggerFunction: addonEndpointUrl(siteUrl, "gmail-message"),
            unconditional: {},
          },
        ],
        homepageTrigger: { runFunction: homepage },
      },
      httpOptions: { authorizationHeader: "SYSTEM_ID_TOKEN" },
    },
    oauthScopes: [...ADDON_OAUTH_SCOPES],
  };
}

/** The commands that deploy and install the add-on, in order. */
export function deploymentCommands(
  deploymentId: string = DEFAULT_DEPLOYMENT_ID,
  fileName = "signudoc-addon.json",
): { command: string; purpose: string }[] {
  return [
    {
      command:
        "gcloud services enable gsuiteaddons.googleapis.com gmail.googleapis.com drive.googleapis.com",
      purpose:
        "In the Google Cloud project that will own the add-on, turn on the APIs it uses.",
    },
    {
      command: `gcloud workspace-add-ons deployments create ${deploymentId} --deployment-file=${fileName}`,
      purpose: "Create the deployment from the JSON above.",
    },
    {
      command: `gcloud workspace-add-ons deployments replace ${deploymentId} --deployment-file=${fileName}`,
      purpose: "Later, after the site's address or the JSON changes.",
    },
    {
      command: "gcloud workspace-add-ons get-authorization",
      purpose:
        "Shows the add-on's service account and OAuth client ID. Paste both below.",
    },
    {
      command: `gcloud workspace-add-ons deployments install ${deploymentId}`,
      purpose:
        "Install it for yourself, to try it before the whole domain gets it.",
    },
  ];
}
