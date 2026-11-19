import { randomBytes } from "node:crypto";

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
import { addonAddressProblem } from "./integrations/google/addon/config.ts";
import {
  ADDON_OAUTH_SCOPES,
  buildAddonDeployment,
} from "./integrations/google/addon/manifest.ts";
import {
  readGoogleProjectId,
  readGoogleProjectNumber,
  resolveGoogleCredentials,
  type GoogleCredentialsSource,
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
  CHECK_TIME_MS,
  listSetupProjects,
  runWorkspaceSetup,
  SETUP_CALLBACK_PATH,
  SETUP_TIME_BUDGET_MS,
  workspaceProjectId,
  workspaceProjectName,
  type SetupEvent,
  type SetupProject,
  type SetupProjectChoice,
  type SetupTestResult,
  type WorkspaceSetupInput,
} from "./integrations/google/workspace-setup.ts";
import { logRouteError } from "./security/logging.ts";
import { getBranding, getSettings } from "./settings.ts";
import { readEnv, resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// The app's side of the automatic Google Workspace setup: where it runs
// (this site's address, its Google identity, the Cloud project), the
// one-time sign-in, the project choice, and the run itself with this
// install's settings and checks. The steps are in
// integrations/google/workspace-setup.ts.

export type GoogleIdentity = {
  email: string;
  source: GoogleCredentialsSource;
};

export type SetupTarget = {
  /** Why the add-on cannot be deployed from here, when it cannot. */
  addonProblem: string | null;
  /** The scopes the add-on asks for, for the Marketplace listing. */
  addonScopes: string[];
  client: DriveOAuthClient | null;
  /** The Google identity the site uses now, or null when it has none. */
  identity: GoogleIdentity | null;
  /** Why the identity could not be read, when it could not. */
  identityProblem: string | null;
  /** A gcloud login is wanted for impersonation, but none is mounted. */
  impersonationPending: string | null;
  /** Why the automatic setup cannot run, when it cannot. */
  problem: string | null;
  /** The project used for console links: the one chosen, or where it runs. */
  projectId: string | null;
  projectNumber: string | null;
  redirectUri: string | null;
  /** The project the site runs in on Google Cloud, if it does. */
  runningIn: string | null;
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

/** The site's Google identity now, and why there is none if there is not. */
export async function describeGoogleIdentity(
  env: EnvSource = process.env,
): Promise<{ identity: GoogleIdentity | null; problem: string | null }> {
  try {
    const credentials = await resolveGoogleCredentials(env);

    if (!credentials) {
      return { identity: null, problem: null };
    }

    return {
      identity: {
        email: await credentials.getServiceAccountEmail(),
        source: credentials.source,
      },
      problem: null,
    };
  } catch (error) {
    return {
      identity: null,
      problem:
        error instanceof Error
          ? error.message
          : "The site's Google identity could not be read.",
    };
  }
}

/** An identity set by where the site runs, which the setup does not change. */
function isFixed(identity: GoogleIdentity, env: EnvSource): boolean {
  return (
    identity.source === "metadata" ||
    identity.source === "service-account-key" ||
    (identity.source === "impersonation" &&
      Boolean(readEnv(env, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT")))
  );
}

export async function describeSetupTarget(
  env: EnvSource = process.env,
): Promise<SetupTarget> {
  const stored = await getIntegrationSettings(env);
  const client = readDriveOAuthClient(env, stored);
  const url = siteUrl(env);
  const { identity, problem: identityProblem } =
    await describeGoogleIdentity(env);
  const runningIn = await readGoogleProjectId({ env });
  const projectId =
    stored["google.cloudProject"] ??
    runningIn ??
    googleProjectId(identity?.email ?? null);
  const projectNumber =
    runningIn && projectId === runningIn
      ? await readGoogleProjectNumber({ env })
      : stored["google.cloudProject"] &&
          projectId === stored["google.cloudProject"]
        ? (stored["drive.appId"] ?? null)
        : null;
  const impersonate = stored["google.impersonateServiceAccount"] ?? null;
  const problem = !url
    ? "This site does not know its own address. Set APP_URL where it runs."
    : !client
      ? "Create the OAuth client and save its ID and secret first (step A)."
      : null;

  return {
    addonProblem: addonAddressProblem(url),
    addonScopes: [...ADDON_OAUTH_SCOPES],
    client,
    identity,
    identityProblem,
    impersonationPending:
      impersonate && identity?.email !== impersonate ? impersonate : null,
    problem,
    projectId,
    projectNumber,
    redirectUri: url ? `${url}${SETUP_CALLBACK_PATH}` : null,
    runningIn,
    serviceAccountEmail: identity?.email ?? null,
    siteUrl: url,
  };
}

async function runChecks(
  adminEmail: string,
  signedInEmail: string,
  state: { deadline: number; exportDriveId: string | null },
  env: EnvSource,
): Promise<SetupTestResult[]> {
  const { exportDriveId } = state;
  const results: SetupTestResult[] = [];
  // A check is started only with the time it may need, so the run ends by
  // its deadline; one that is not started says so.
  const outOfTime = (name: string) => {
    if (Date.now() + CHECK_TIME_MS < state.deadline) {
      return false;
    }

    results.push({
      message: "not run, the setup ran out of time.",
      name,
      ok: false,
    });
    return true;
  };

  if (outOfTime("Directory")) {
    return results;
  }

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

  if (
    readAdminGroup(env, await getIntegrationSettings(env)).group &&
    !outOfTime("Administrator group")
  ) {
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

  if (exportDriveId && !outOfTime("Shared Drive")) {
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

// The project choice. The run sends the projects to the page and waits;
// the page sends the choice to another request, which may reach another
// instance, so it goes through the database.

/** How long the run waits for the administrator to choose a project. */
export const CHOICE_WAIT_MS = 180_000;
const CHOICE_POLL_MS = 1000;
const WAITING_EVENT_MS = 15_000;
// Choices nobody collected are removed after this long.
const CHOICE_TTL_SECONDS = 60 * 60;

/** Records the administrator's choice for a run. False when it is not new. */
export async function submitProjectChoice(input: {
  choice: SetupProjectChoice;
  runId: string;
  userId: string;
}): Promise<boolean> {
  const result = await getDb().query(
    `INSERT INTO public.google_setup_choices (run_id, user_id, choice, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      input.runId,
      input.userId,
      JSON.stringify(input.choice),
      Math.floor(Date.now() / 1000),
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

function parseChoice(value: string): SetupProjectChoice | null {
  try {
    const parsed = JSON.parse(value) as Partial<{
      create: unknown;
      projectId: unknown;
    }>;

    if (parsed.create === true) {
      return { create: true };
    }

    return parsed.create === false && typeof parsed.projectId === "string"
      ? { create: false, projectId: parsed.projectId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Waits for the choice for this run from this person, and takes it. Null
 * when none came in time.
 */
async function waitForProjectChoice(input: {
  emit: (event: SetupEvent) => void;
  runId: string;
  sleep: (ms: number) => Promise<void>;
  userId: string;
  waitMs: number;
}): Promise<SetupProjectChoice | null> {
  const database = getDb();
  const until = Date.now() + input.waitMs;
  let lastSent = Date.now();

  await database.query(
    `DELETE FROM public.google_setup_choices WHERE created_at < $1`,
    [Math.floor(Date.now() / 1000) - CHOICE_TTL_SECONDS],
  );

  while (Date.now() < until) {
    const taken = await database.query<{ choice: string }>(
      `DELETE FROM public.google_setup_choices
       WHERE run_id = $1 AND user_id = $2
       RETURNING choice`,
      [input.runId, input.userId],
    );
    const row = taken.rows[0];

    if (row) {
      return parseChoice(row.choice);
    }

    // A line now and then keeps proxies from closing a quiet stream.
    if (Date.now() - lastSent >= WAITING_EVENT_MS) {
      lastSent = Date.now();
      input.emit({ type: "waiting" });
    }

    await input.sleep(CHOICE_POLL_MS);
  }

  return null;
}

/** The project number in an OAuth client ID, such as 1234-abc.apps.... */
function clientProjectNumber(clientId: string): string | null {
  return /^(\d{6,20})-/.exec(clientId)?.[1] ?? null;
}

type RunInput = {
  actor: IntegrationSettingsActor;
  code: string;
  codeVerifier: string;
  emit: (event: SetupEvent) => void;
  env?: EnvSource;
  exportDrive: boolean;
  /** How long to wait for the project choice; CHOICE_WAIT_MS by default. */
  choiceWaitMs?: number;
  /** Waits between polls; tests make it short. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Exchanges the code from the one-time sign-in, offers the projects, runs
 * every step, and revokes the token whatever happened. Each event is passed
 * on as it happens; one that cannot be sent (the page went away) does not
 * stop the run.
 */
export async function runAutomaticSetup(input: RunInput): Promise<void> {
  // The run's time is counted from here, so the code exchange and the
  // reads before the steps are inside it too. Only the wait for the
  // administrator's choice is not.
  const startedAt = Date.now();
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
    await runWithGrant({ ...input, emit }, env, startedAt, {
      ...target,
      client: target.client,
      redirectUri: target.redirectUri,
      siteUrl: target.siteUrl,
    });
  } finally {
    await release();
  }
}

type ReadyTarget = SetupTarget & {
  client: DriveOAuthClient;
  redirectUri: string;
  siteUrl: string;
};

async function runWithGrant(
  input: RunInput,
  env: EnvSource,
  startedAt: number,
  target: ReadyTarget,
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
    const hostedDomain = readHostedDomain(token.idToken);
    // Held to the install's own Workspace, as Google sign-in is: a super
    // admin of another organization's Workspace is not set up with.
    const workspace = claims
      ? checkWorkspaceAccount(
          { hd: hostedDomain },
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
      ok = await chooseAndRun({
        accessToken: token.accessToken,
        adminEmail: claims.email,
        env,
        hostedDomain,
        input,
        startedAt,
        target,
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

async function chooseAndRun({
  accessToken,
  adminEmail,
  env,
  hostedDomain,
  input,
  startedAt,
  target,
}: {
  accessToken: string;
  adminEmail: string;
  env: EnvSource;
  hostedDomain: string | null;
  input: RunInput;
  startedAt: number;
  target: ReadyTarget;
}): Promise<boolean> {
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stored = await getIntegrationSettings(env);
  const [{ productName }, settings] = await Promise.all([
    getBranding(env),
    getSettings(env),
  ]);
  const clientProject = clientProjectNumber(target.client.clientId);
  const listed = await listSetupProjects({
    accessToken,
    clientProject,
    deadline: startedAt + SETUP_TIME_BUDGET_MS,
    env,
    hostedDomain,
    sleep: input.sleep,
  });
  const offered: SetupProject[] = listed.projects;
  const remembered = stored["google.cloudProject"] ?? null;
  const preselect = (
    [
      [target.runningIn, "This site runs in it."],
      [remembered, "The setup used it last time."],
      [
        googleProjectId(target.identity?.email ?? null),
        "The site's service account belongs to it.",
      ],
    ] as const
  ).find(([id]) => id && offered.some((item) => item.projectId === id));
  const runId = randomBytes(24).toString("base64url");
  const spentMs = Date.now() - startedAt;

  input.emit({
    newProjectName: workspaceProjectName(productName),
    organization: listed.organization,
    preselected: preselect?.[0] ?? null,
    projects: offered,
    reason: preselect?.[1] ?? listed.problem,
    runId,
    type: "choose",
    waitSeconds: Math.round((input.choiceWaitMs ?? CHOICE_WAIT_MS) / 1000),
  });

  const choice = await waitForProjectChoice({
    emit: input.emit,
    runId,
    sleep,
    userId: input.actor.id,
    waitMs: input.choiceWaitMs ?? CHOICE_WAIT_MS,
  });
  const chosen =
    choice && !choice.create
      ? offered.find((item) => item.projectId === choice.projectId)
      : null;

  if (!choice || (!choice.create && !chosen)) {
    input.emit({
      hint: "Start the setup again and choose a project.",
      message: choice
        ? "That project is not one this account can use."
        : "No project was chosen in time.",
      type: "refused",
    });
    return false;
  }

  const project: WorkspaceSetupInput["project"] = chosen
    ? {
        create: false,
        projectId: chosen.projectId,
        projectNumber: chosen.number,
      }
    : {
        create: true,
        name: workspaceProjectName(productName),
        parent: listed.organization,
        projectId: workspaceProjectId(
          productName,
          randomBytes(6).toString("hex"),
        ),
      };
  const current = target.identity;
  const fixed = current && isFixed(current, env) ? current : null;
  const identityProject = googleProjectId(fixed?.email ?? null);
  const siteUrl = target.siteUrl;
  const addonProblem = addonAddressProblem(siteUrl);

  return runWorkspaceSetup({
    accessToken,
    addon: addonProblem
      ? { skipped: addonProblem }
      : {
          deployment: buildAddonDeployment({
            brandColor: settings.brandColor,
            name: productName,
            siteUrl,
          }),
        },
    adminEmail,
    appName: productName,
    // The steps get the run's time less what was spent before the choice.
    deadline: Date.now() + SETUP_TIME_BUDGET_MS - spentMs,
    emit: input.emit,
    env,
    existing: {
      addonClientId: stored["google.addonClientId"] ?? null,
      addonServiceAccount: stored["google.addonServiceAccount"] ?? null,
      appId: stored["drive.appId"] ?? null,
      cloudProject: remembered,
      customerId: stored["google.customerId"] ?? null,
      directory: stored["google.directory"] ?? null,
      exportDriveId: stored["drive.exportDriveId"] ?? null,
      pickerApiKey: stored["drive.pickerApiKey"] ?? null,
    },
    exportDrive: input.exportDrive,
    extraProjects: [clientProject, identityProject].filter(
      (value): value is string => Boolean(value),
    ),
    identity: { fixed, saved: current && !fixed ? current : null },
    project,
    runTests: (state) => runChecks(adminEmail, input.actor.email, state, env),
    save: async (update) => {
      await saveIntegrationSettings(update, input.actor, {
        area: "google_workspace",
        env,
      });
    },
    siteUrl,
    sleep: input.sleep,
  });
}

/** What the setup page needs to know, without the OAuth client's secret. */
export type SetupTargetView = Omit<SetupTarget, "client"> & {
  clientReady: boolean;
};

export function toSetupTargetView(target: SetupTarget): SetupTargetView {
  const { client, ...rest } = target;

  return { ...rest, clientReady: client !== null };
}
