import { randomBytes } from "node:crypto";

import { logRouteError } from "../../../../security/logging.ts";
import { readEnv, type EnvSource } from "../../../../utils/env.ts";
import { addInAddressProblem } from "../../../add-in-support.ts";
import {
  resolveWorkspaceSetting,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdate,
} from "../../../settings.ts";
import type {
  WorkspaceAutomaticRunInput,
  WorkspaceAutomaticSetup,
  WorkspaceCheck,
  WorkspaceCheckContext,
  WorkspaceCheckTarget,
  WorkspaceSetupOption,
} from "../../../types.ts";
import { buildAddonDeployment } from "../addon/manifest.ts";
import {
  GOOGLE_SCOPES,
  googleCredentialsFor,
  readGoogleProjectId,
  type GoogleCredentials,
  type GoogleCredentialsSource,
} from "../credentials.ts";
import {
  createPkcePair,
  exchangeAuthorizationCode,
  GOOGLE_AUTHORIZATION_URL,
  readDriveOAuthClient,
  readIdTokenClaims,
  revokeToken,
  type TokenResponse,
} from "../drive/drive-oauth.ts";
import { googleUrl } from "../endpoints.ts";
import { googleProjectId } from "./console.ts";
import {
  NEW_PROJECT_OPTION,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  workspaceProjectId,
  workspaceProjectName,
} from "./names.ts";
import {
  CHECK_TIME_MS,
  createSetupClient,
  describeSetupFailure,
  runGoogleSetupSteps,
  type SetupProject,
  type SetupTestResult,
} from "./steps.ts";

// Google's automatic setup (WorkspaceAutomaticSetup in ../../../types.ts):
// the one-time sign-in as a Workspace super admin through the site's OAuth
// client, the choice of Cloud project, the steps (steps.ts), and the
// revoke. The app keeps the sign-in's state and PKCE verifier in a cookie,
// passes the administrator's choice through the database and holds the
// lock (workspace/workspace-setup.ts); this file never stores the token.

const ROLE_MANAGEMENT_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.rolemanagement";
const CUSTOMER_READ_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.customer.readonly";

/** The toggle that asks for a Shared Drive for executed copies. */
export const EXPORT_DRIVE_TOGGLE = "exportDrive";

/** What the one-time sign-in asks for. Drive only when a Shared Drive is made. */
export function setupScopes(exportDrive: boolean): string[] {
  return [
    "openid",
    "email",
    GOOGLE_SCOPES.cloudPlatform,
    ROLE_MANAGEMENT_SCOPE,
    GOOGLE_SCOPES.directoryUserReadonly,
    CUSTOMER_READ_SCOPE,
    ...(exportDrive ? [GOOGLE_SCOPES.drive] : []),
  ];
}

export function buildSetupAuthorizationUrl(input: {
  clientId: string;
  codeChallenge: string;
  env?: EnvSource;
  exportDrive: boolean;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    // No refresh token: the grant ends with the request.
    access_type: "online",
    client_id: input.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    // Always asks, so a super admin other than the signed-in person can be
    // chosen, and every scope is shown.
    prompt: "select_account consent",
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: setupScopes(input.exportDrive).join(" "),
    state: input.state,
  });

  return `${googleUrl(GOOGLE_AUTHORIZATION_URL, input.env)}?${params.toString()}`;
}

// Before the steps: the projects the administrator can choose from.

const PROJECT_PAGES = 5;

export type ListedProject = {
  name: string;
  /** The project number, which the Picker uses as its app ID. */
  number: string | null;
  projectId: string;
};

/**
 * The Cloud projects the signed-in administrator can use, and the
 * organization of their Workspace, for the project choice. The sign-in
 * client's project gets the Cloud Resource Manager API first, since the
 * administrator's own calls count against it. A failure to list is
 * reported, not thrown, so a new project can still be offered.
 */
export async function listSetupProjects(input: {
  accessToken: string;
  /** The sign-in client's project number, from its client ID. */
  clientProject: string | null;
  deadline: number;
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  /** The Workspace domain of the administrator, from the ID token. */
  hostedDomain: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  organization: string | null;
  problem: string | null;
  projects: ListedProject[];
}> {
  const { call, finish } = createSetupClient(input, input.deadline);
  const crm = "cloudresourcemanager.googleapis.com";

  if (input.clientProject) {
    const services = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(input.clientProject)}/services/${crm}`;

    try {
      const current = await call<{ state?: string }>("GET", services);

      if (current.state !== "ENABLED") {
        await finish(
          "https://serviceusage.googleapis.com/v1",
          await call<{ done?: boolean; name?: string }>(
            "POST",
            `${services}:enable`,
            {},
          ),
        );
      }
    } catch {
      // Listing says what is wrong, if anything is.
    }
  }

  const projects: ListedProject[] = [];
  let problem: string | null = null;

  try {
    let pageToken = "";

    for (let pageCount = 0; pageCount < PROJECT_PAGES; pageCount += 1) {
      const page = await call<{
        nextPageToken?: string;
        projects?: Array<{
          displayName?: string;
          name?: string;
          projectId?: string;
          state?: string;
        }>;
      }>(
        "GET",
        `https://cloudresourcemanager.googleapis.com/v3/projects:search?query=${encodeURIComponent("state:ACTIVE")}&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );

      for (const item of page.projects ?? []) {
        if (item.projectId && (item.state ?? "ACTIVE") === "ACTIVE") {
          projects.push({
            name: item.displayName || item.projectId,
            number: /^projects\/(\d+)$/.exec(item.name ?? "")?.[1] ?? null,
            projectId: item.projectId,
          });
        }
      }

      pageToken = page.nextPageToken ?? "";

      if (!pageToken) {
        break;
      }
    }
  } catch (error) {
    problem = describeSetupFailure(error, {
      403: "This account cannot list Cloud projects. A new project can still be made.",
    });
  }

  let organization: string | null = null;

  if (input.hostedDomain) {
    try {
      const found = await call<{ organizations?: Array<{ name?: string }> }>(
        "GET",
        `https://cloudresourcemanager.googleapis.com/v3/organizations:search?query=${encodeURIComponent(`domain:${input.hostedDomain}`)}`,
      );

      organization =
        found.organizations?.find((item) =>
          /^organizations\/\d+$/.test(item.name ?? ""),
        )?.name ?? null;
    } catch {
      // A project with no organization can still be made.
    }
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));

  return { organization, problem, projects };
}

/** The ID token's hd claim: the Workspace the account belongs to. */
export function readHostedDomain(idToken: string | null): string | null {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { hd?: unknown };

    return typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The project number in an OAuth client ID, such as 1234-abc.apps.... */
function clientProjectNumber(clientId: string): string | null {
  return /^(\d{6,20})-/.exec(clientId)?.[1] ?? null;
}

type FixedIdentity = { email: string; source: GoogleCredentialsSource };

/** The site's identity now, and why it cannot be read when it cannot. */
async function readSiteIdentity(
  credentialsFor: () => GoogleCredentials | null,
): Promise<{ identity: FixedIdentity | null; problem: string | null }> {
  try {
    const credentials = credentialsFor();

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

/** Waits for a promise, or gives up at the deadline. */
async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type GoogleAutomaticSetupOptions = {
  /**
   * Runs the site's own checks with these settings (setup.ts), for the
   * last step.
   */
  check: (
    target: WorkspaceCheckTarget,
    settings: WorkspaceSettings,
    context: WorkspaceCheckContext,
  ) => Promise<WorkspaceCheck[]>;
  env?: EnvSource;
  /** Reaches Google for the listing and the steps; tests slow it down. */
  fetchImpl?: typeof fetch;
  /** For tests; the shared credentials otherwise. */
  getCredentials?: () => GoogleCredentials | null;
  /** Waits between polls; tests make it short. */
  sleep?: (ms: number) => Promise<void>;
};

export function createGoogleAutomaticSetup({
  check,
  env = process.env,
  fetchImpl,
  getCredentials,
  sleep,
}: GoogleAutomaticSetupOptions): WorkspaceAutomaticSetup {
  const credentialsFor = getCredentials ?? (() => googleCredentialsFor(env));

  /** Offers the projects, waits for the choice, and runs every step. */
  async function chooseAndRun(
    input: WorkspaceAutomaticRunInput,
    token: TokenResponse,
    adminEmail: string,
    hostedDomain: string | null,
    clientId: string,
  ): Promise<boolean> {
    const appName = input.site.name;
    const siteUrl = input.site.url ?? "";
    const clientProject = clientProjectNumber(clientId);
    const listed = await listSetupProjects({
      accessToken: token.accessToken,
      clientProject,
      deadline: input.deadline,
      env,
      fetchImpl,
      hostedDomain,
      sleep,
    });
    const { identity: fixed, problem: identityProblem } =
      await readSiteIdentity(credentialsFor);
    const runningIn = await readGoogleProjectId({ env });
    const remembered = resolveWorkspaceSetting(
      "google.cloudProject",
      input.settings,
      env,
    );
    const preselect = (
      [
        [
          remembered.source === "env" ? remembered.value : null,
          "GOOGLE_WORKSPACE_PROJECT names it.",
        ],
        [runningIn, "This site runs in it."],
        [remembered.value, "The setup used it last time."],
        [
          googleProjectId(fixed?.email ?? null),
          "The site's service account belongs to it.",
        ],
      ] as const
    ).find(
      ([id]) => id && listed.projects.some((item) => item.projectId === id),
    );
    const newName = workspaceProjectName(appName);
    const options: WorkspaceSetupOption[] = [
      ...listed.projects.map((item) => ({
        detail: item.projectId,
        id: item.projectId,
        label: item.name,
      })),
      {
        detail: `${listed.organization ? "In your organization" : "With no organization"}. It needs no billing account.`,
        id: NEW_PROJECT_OPTION,
        label: `Create "${newName}"`,
      },
    ];
    const choice = await input.choose({
      options,
      preselected: preselect?.[0] ?? null,
      question:
        "Which Google Cloud project should this site use? The APIs, the Picker key, the add-on and, off Google Cloud, the site's service account go in it.",
      reason: preselect?.[1] ?? listed.problem,
    });
    const chosen =
      choice && choice !== NEW_PROJECT_OPTION
        ? listed.projects.find((item) => item.projectId === choice)
        : null;

    if (!choice || (choice !== NEW_PROJECT_OPTION && !chosen)) {
      input.emit({
        hint: "Start the setup again and choose a project.",
        message: choice
          ? "That project is not one this account can use."
          : "No project was chosen in time.",
        type: "refused",
      });
      return false;
    }

    const project: SetupProject = chosen
      ? {
          create: false,
          projectId: chosen.projectId,
          projectNumber: chosen.number,
        }
      : {
          create: true,
          name: newName,
          parent: listed.organization,
          projectId: workspaceProjectId(
            appName,
            randomBytes(6).toString("hex"),
          ),
        };
    // An identity set where the site runs that cannot be read (a key that
    // does not parse, impersonation with no gcloud login mounted) is still
    // the one to use: the setup reports it rather than make another.
    const envKey = readEnv(env, "GOOGLE_SERVICE_ACCOUNT_KEY");
    const envTarget = readEnv(env, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT");
    const unreadable =
      !fixed && (envKey || envTarget)
        ? {
            email: envKey ? null : (envTarget ?? null),
            problem:
              identityProblem ??
              "The Google identity set where the site runs cannot be read.",
          }
        : null;
    const addonProblem = addInAddressProblem(input.site.url);
    // What is saved as the run goes, so the checks at the end see it.
    const current: WorkspaceSettings = { ...input.settings };
    const save = async (update: WorkspaceSettingsUpdate) => {
      await input.save(update);

      for (const [key, value] of Object.entries(update) as Array<
        [keyof WorkspaceSettings, string | null | undefined]
      >) {
        if (value === null) {
          delete current[key];
        } else if (value !== undefined) {
          current[key] = value;
        }
      }
    };

    return runGoogleSetupSteps({
      accessToken: token.accessToken,
      addon: addonProblem
        ? { skipped: addonProblem }
        : {
            deployment: buildAddonDeployment({
              brandColor: input.site.brandColor,
              name: appName,
              siteUrl,
            }),
          },
      adminEmail,
      appName,
      deadline: input.deadline,
      emit: input.emit,
      env,
      exportDrive: input.toggles[EXPORT_DRIVE_TOGGLE] !== false,
      extraProjects: [
        clientProject,
        googleProjectId(fixed?.email ?? null),
      ].filter((value): value is string => Boolean(value)),
      fetchImpl,
      identity: { fixed, unreadable },
      project,
      runTests: async (state) => runChecks(state, current, adminEmail),
      save,
      siteUrl,
      sleep,
      stored: input.settings,
    });
  }

  /**
   * The site's own checks with its own identity: the directory, and the
   * Shared Drive when there is one. A check is started only with the time
   * it may need, and given up at the deadline; one not run says so.
   */
  async function runChecks(
    state: { deadline: number; exportDestination: string | null },
    settings: WorkspaceSettings,
    adminEmail: string,
  ): Promise<SetupTestResult[]> {
    const targets: WorkspaceCheckTarget[] = [
      "directory",
      ...(state.exportDestination ? (["files"] as const) : []),
    ];
    const results: SetupTestResult[] = [];

    for (const target of targets) {
      if (Date.now() + CHECK_TIME_MS >= state.deadline) {
        results.push({
          message: "not run, the setup ran out of time.",
          name: target === "files" ? "Files" : "Directory",
          ok: false,
        });
        continue;
      }

      const checks = await beforeDeadline(
        check(target, settings, { email: adminEmail }),
        state.deadline,
      );

      if (!checks) {
        results.push({
          message: "did not answer in time.",
          name: target === "files" ? "Files" : "Directory",
          ok: false,
        });
        continue;
      }

      results.push(
        ...checks.map((item) => ({
          message: item.message,
          name: item.name,
          ok: item.ok,
        })),
      );
    }

    return results;
  }

  return {
    describe(site) {
      const client = readDriveOAuthClient(env);

      return {
        problem: !site.url
          ? "This site does not know its own address. Set APP_URL where it runs."
          : !client
            ? "The automatic setup signs in through this site's Google OAuth client. Create it (the first step of the guide), then set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET where the site runs, or use Google for single sign-on, whose client is used then."
            : null,
        signIn: [
          "You sign in once with Google as a Workspace super admin who can also change Cloud projects: an Owner of the project, or Project Creator to make a new one.",
          "Google asks you to allow: managing Cloud projects, APIs, keys and service accounts (cloud-platform); managing admin roles; reading users and the customer ID; and, when a Shared Drive is made, Google Drive.",
          "The token lives only as long as the setup's own request on this server. It is revoked when the setup ends, whatever happened, and it is never stored or sent to this page.",
        ],
        steps: SETUP_STEP_ORDER.map((id) => ({
          id,
          title: SETUP_STEP_TITLES[id],
        })),
        toggles: [
          {
            defaultOn: true,
            id: EXPORT_DRIVE_TOGGLE,
            label: "Keep executed copies in a Shared Drive",
          },
        ],
      };
    },

    async run(input) {
      const client = readDriveOAuthClient(env);

      if (!client || !input.site.url) {
        input.emit({
          message: "The automatic setup cannot run here.",
          type: "refused",
        });
        return { ok: false, revoked: true };
      }

      let token: TokenResponse;

      try {
        token = await exchangeAuthorizationCode({
          client,
          code: input.code,
          codeVerifier: input.secret,
          env,
          fetchImpl,
          redirectUri: input.redirectUri,
        });
      } catch {
        input.emit({
          hint: "Check that the setup's redirect URI is on the OAuth client, then try again.",
          message: "Google did not accept the sign-in.",
          type: "refused",
        });
        return { ok: false, revoked: true };
      }

      let ok = false;
      let revoked = false;

      try {
        const claims = readIdTokenClaims(token.idToken);
        const hostedDomain = readHostedDomain(token.idToken);
        const domains = input.organizationDomains;

        if (!claims) {
          input.emit({
            message: "Google did not say which account signed in.",
            type: "refused",
          });
        } else if (
          domains.length > 0 &&
          !(hostedDomain && domains.includes(hostedDomain))
        ) {
          // Held to the organization's own Workspace: a super admin of
          // someone else's is not set up with.
          input.emit({
            hint: "Sign in with a super admin of this organization's Google Workspace.",
            message: `${claims.email} is not in this organization's Google Workspace.`,
            type: "refused",
          });
        } else {
          ok = await chooseAndRun(
            input,
            token,
            claims.email,
            hostedDomain,
            client.clientId,
          );
        }
      } catch (error) {
        // The page gets our own words; the log gets the error.
        logRouteError(error, {
          category: "workspace_setup_failure",
          message: "Unexpected failure in the automatic Google setup.",
        });
        input.emit({
          message: "The setup stopped unexpectedly.",
          type: "refused",
        });
      } finally {
        revoked = await revokeToken(token.accessToken, { env, fetchImpl });
      }

      return { ok, revoked };
    },

    start({ redirectUri, state, toggles }) {
      const client = readDriveOAuthClient(env);

      if (!client) {
        throw new Error("The site has no Google OAuth client.");
      }

      const { challenge, verifier } = createPkcePair();

      return {
        secret: verifier,
        url: buildSetupAuthorizationUrl({
          clientId: client.clientId,
          codeChallenge: challenge,
          env,
          exportDrive: toggles[EXPORT_DRIVE_TOGGLE] !== false,
          redirectUri,
          state,
        }),
      };
    },
  };
}
