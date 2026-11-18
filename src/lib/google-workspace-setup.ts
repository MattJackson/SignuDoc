import { googleProjectId } from "./google-console.ts";
import { testSharedDrive } from "./google-drive.ts";
import { testDirectoryAccess, testGroupLookup } from "./google-workspace.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettingsActor,
} from "./integration-settings.ts";
import {
  getGoogleCredentials,
  readGoogleProjectId,
  readGoogleProjectNumber,
} from "./integrations/google/credentials.ts";
import {
  exchangeAuthorizationCode,
  readDriveOAuthClient,
  readIdTokenClaims,
  revokeToken,
  type DriveOAuthClient,
} from "./integrations/google/drive-oauth.ts";
import { readAdminGroup } from "./google-admin-group.ts";
import {
  runWorkspaceSetup,
  SETUP_CALLBACK_PATH,
  type SetupEvent,
  type SetupTestResult,
} from "./integrations/google/workspace-setup.ts";
import { getBranding } from "./settings.ts";
import { resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// The app's side of the automatic Google Workspace setup: where it runs
// (the Cloud project, the service account, this site's address), the
// one-time sign-in, and the run itself with this install's settings and
// checks. The steps are in integrations/google/workspace-setup.ts.

export type SetupTarget = {
  client: DriveOAuthClient | null;
  /** Why the automatic setup cannot run, when it cannot. */
  problem: string | null;
  projectId: string | null;
  projectNumber: string | null;
  redirectUri: string | null;
  serviceAccountEmail: string | null;
  siteUrl: string | null;
};

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

export async function describeSetupTarget(
  env: EnvSource = process.env,
): Promise<SetupTarget> {
  const stored = await getIntegrationSettings(env);
  const client = readDriveOAuthClient(env, stored);
  const url = siteUrl(env);
  let serviceAccountEmail: string | null = null;

  try {
    serviceAccountEmail =
      (await getGoogleCredentials()?.getServiceAccountEmail()) ?? null;
  } catch {
    serviceAccountEmail = null;
  }

  const projectId =
    googleProjectId(serviceAccountEmail) ??
    (await readGoogleProjectId({ env }));
  const projectNumber = await readGoogleProjectNumber({ env });
  const problem = !url
    ? "This site does not know its own address. Set APP_URL where it runs."
    : !serviceAccountEmail
      ? "This site has no Google service account: run it on Google Cloud, or set GOOGLE_SERVICE_ACCOUNT_KEY."
      : !projectId
        ? "The Google Cloud project could not be found. Set GOOGLE_CLOUD_PROJECT where the site runs."
        : !client
          ? "Create the OAuth client and save its ID and secret first (step A)."
          : null;

  return {
    client,
    problem,
    projectId,
    projectNumber,
    redirectUri: url ? `${url}${SETUP_CALLBACK_PATH}` : null,
    serviceAccountEmail,
    siteUrl: url,
  };
}

async function runChecks(
  adminEmail: string,
  signedInEmail: string,
  exportDriveId: string | null,
  env: EnvSource,
): Promise<SetupTestResult[]> {
  const results: SetupTestResult[] = [];
  const directory = await testDirectoryAccess(adminEmail, env);

  results.push(
    directory.ok
      ? {
          message: `the site's service account found ${directory.people
            .map((person) => person.email)
            .join(", ")}.`,
          name: "Directory",
          ok: true,
        }
      : { message: directory.message, name: "Directory", ok: false },
  );

  if (readAdminGroup(env, await getIntegrationSettings(env)).group) {
    const group = await testGroupLookup(signedInEmail, null, env);

    results.push(
      group.ok
        ? {
            message: `${group.group} can be read.`,
            name: "Administrator group",
            ok: true,
          }
        : { message: group.message, name: "Administrator group", ok: false },
    );
  }

  if (exportDriveId) {
    const drive = await testSharedDrive(exportDriveId, env);

    results.push(
      drive.ok && drive.canAddChildren
        ? {
            message: `the service account can add files to "${drive.name}".`,
            name: "Shared Drive",
            ok: true,
          }
        : {
            message: drive.ok
              ? `the service account cannot add files to "${drive.name}" yet.`
              : drive.message,
            name: "Shared Drive",
            ok: false,
          },
    );
  }

  return results;
}

/**
 * Exchanges the code from the one-time sign-in, runs every step, and
 * revokes the token whatever happened. Each event is passed on as it
 * happens.
 */
export async function runAutomaticSetup(input: {
  actor: IntegrationSettingsActor;
  code: string;
  codeVerifier: string;
  emit: (event: SetupEvent) => void;
  env?: EnvSource;
  exportDrive: boolean;
}): Promise<void> {
  const env = input.env ?? process.env;
  const target = await describeSetupTarget(env);

  if (
    target.problem ||
    !target.client ||
    !target.redirectUri ||
    !target.serviceAccountEmail ||
    !target.projectId ||
    !target.siteUrl
  ) {
    input.emit({
      message: target.problem ?? "The setup cannot run here.",
      type: "refused",
    });
    input.emit({ ok: false, revoked: true, type: "finished" });
    return;
  }

  let token;

  try {
    token = await exchangeAuthorizationCode({
      client: target.client,
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: target.redirectUri,
    });
  } catch {
    input.emit({
      hint: "Check that the redirect URI from step A is on the OAuth client, then try again.",
      message: "Google did not accept the sign-in.",
      type: "refused",
    });
    input.emit({ ok: false, revoked: true, type: "finished" });
    return;
  }

  let ok = false;

  try {
    const claims = readIdTokenClaims(token.idToken);

    if (!claims) {
      input.emit({
        message: "Google did not say which account signed in.",
        type: "refused",
      });
    } else {
      const stored = await getIntegrationSettings(env);
      const { productName } = await getBranding(env);

      ok = await runWorkspaceSetup({
        accessToken: token.accessToken,
        adminEmail: claims.email,
        appName: productName,
        emit: input.emit,
        env,
        existing: {
          appId: stored["drive.appId"] ?? null,
          customerId: stored["google.customerId"] ?? null,
          directory: stored["google.directory"] ?? null,
          exportDriveId: stored["drive.exportDriveId"] ?? null,
          pickerApiKey: stored["drive.pickerApiKey"] ?? null,
        },
        exportDrive: input.exportDrive,
        projectId: target.projectId,
        projectNumber: target.projectNumber,
        runTests: ({ exportDriveId }) =>
          runChecks(claims.email, input.actor.email, exportDriveId, env),
        save: async (update) => {
          await saveIntegrationSettings(update, input.actor, {
            area: "google_workspace",
            env,
          });
        },
        serviceAccountEmail: target.serviceAccountEmail,
        siteUrl: target.siteUrl,
      });
    }
  } catch (error) {
    input.emit({
      message:
        error instanceof Error
          ? error.message
          : "The setup stopped unexpectedly.",
      type: "refused",
    });
  } finally {
    const revoked = await revokeToken(token.accessToken);

    input.emit({ ok, revoked, type: "finished" });
  }
}

/** What the setup page needs to know, without the OAuth client's secret. */
export type SetupTargetView = Omit<SetupTarget, "client"> & {
  clientReady: boolean;
};

export function toSetupTargetView(target: SetupTarget): SetupTargetView {
  return {
    clientReady: target.client !== null,
    problem: target.problem,
    projectId: target.projectId,
    projectNumber: target.projectNumber,
    redirectUri: target.redirectUri,
    serviceAccountEmail: target.serviceAccountEmail,
    siteUrl: target.siteUrl,
  };
}
