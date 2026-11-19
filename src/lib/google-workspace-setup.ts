import { checkWorkspaceAccount } from "./auth/sso.ts";
import { getDb } from "./db/connection.ts";
import { addonWorkspaceDomains } from "./google-addon.ts";
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
import { logRouteError } from "./security/logging.ts";
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

  // One project for every Cloud call and console link: the one the site
  // runs in (GOOGLE_CLOUD_PROJECT or the metadata server), whose number
  // the metadata server gives, or else the service account's own, whose
  // number step b asks Google for.
  const runningIn = await readGoogleProjectId({ env });
  const projectId = runningIn ?? googleProjectId(serviceAccountEmail);
  const projectNumber = runningIn
    ? await readGoogleProjectNumber({ env })
    : null;
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

// One automatic setup at a time, across instances: two at once would both
// find nothing yet and both make the key, the role and the Shared Drive.
const GOOGLE_SETUP_LOCK_ID = 746108360;

/**
 * Takes the setup's lock, held by a transaction on a connection of its own
 * that writes nothing, as the daily cleanup's is (retention-job.ts). Gives
 * back how to let it go, or null when another run holds it.
 */
async function takeSetupLock(): Promise<(() => Promise<void>) | null> {
  const client = await getDb().connect();
  const release = async () => {
    await client.query("rollback").catch(() => undefined);
    client.release();
  };

  try {
    await client.query("begin");

    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [GOOGLE_SETUP_LOCK_ID],
    );

    if (lock.rows[0]?.locked) {
      return release;
    }
  } catch (error) {
    await release();
    throw error;
  }

  await release();
  return null;
}

/** The ID token's hd claim: the Workspace the account belongs to. */
function readHostedDomain(idToken: string | null): string | null {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { hd?: unknown };

    return typeof claims.hd === "string" ? claims.hd : null;
  } catch {
    return null;
  }
}

type RunInput = {
  actor: IntegrationSettingsActor;
  code: string;
  codeVerifier: string;
  emit: (event: SetupEvent) => void;
  env?: EnvSource;
  exportDrive: boolean;
};

/**
 * Exchanges the code from the one-time sign-in, runs every step, and
 * revokes the token whatever happened. Each event is passed on as it
 * happens; one that cannot be sent (the page went away) does not stop the
 * run.
 */
export async function runAutomaticSetup(input: RunInput): Promise<void> {
  const env = input.env ?? process.env;
  const emit = (event: SetupEvent) => {
    try {
      input.emit(event);
    } catch {
      // Nobody is reading any more.
    }
  };
  const target = await describeSetupTarget(env);

  if (
    target.problem ||
    !target.client ||
    !target.redirectUri ||
    !target.serviceAccountEmail ||
    !target.projectId ||
    !target.siteUrl
  ) {
    emit({
      message: target.problem ?? "The setup cannot run here.",
      type: "refused",
    });
    emit({ ok: false, revoked: true, type: "finished" });
    return;
  }

  const release = await takeSetupLock();

  if (!release) {
    emit({
      hint: "Wait for it to finish, then start the setup again.",
      message: "Another automatic setup is already running.",
      type: "refused",
    });
    emit({ ok: false, revoked: true, type: "finished" });
    return;
  }

  try {
    await runWithGrant({ ...input, emit }, env, {
      client: target.client,
      projectId: target.projectId,
      projectNumber: target.projectNumber,
      redirectUri: target.redirectUri,
      serviceAccountEmail: target.serviceAccountEmail,
      siteUrl: target.siteUrl,
    });
  } finally {
    await release();
  }
}

async function runWithGrant(
  input: RunInput,
  env: EnvSource,
  target: {
    client: DriveOAuthClient;
    projectId: string;
    projectNumber: string | null;
    redirectUri: string;
    serviceAccountEmail: string;
    siteUrl: string;
  },
): Promise<void> {
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
    // Held to the install's own Workspace, as Google sign-in is: a super
    // admin of another organization's Workspace is not set up with.
    const workspace = claims
      ? checkWorkspaceAccount(
          { hd: readHostedDomain(token.idToken) },
          await addonWorkspaceDomains(env),
        )
      : null;

    if (!claims) {
      input.emit({
        message: "Google did not say which account signed in.",
        type: "refused",
      });
    } else if (workspace && !workspace.allowed) {
      input.emit({
        hint: "Sign in with a super admin of this organization's Google Workspace.",
        message: `${claims.email}: ${workspace.message}`,
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
    // The page gets our own words; the log gets the error.
    logRouteError(error, {
      category: "google_workspace_setup_failure",
      ipAddress: input.actor.ipAddress ?? null,
      message: "Unexpected failure in the automatic Google setup.",
      userId: input.actor.id,
    });
    input.emit({
      message: "The setup stopped unexpectedly.",
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
