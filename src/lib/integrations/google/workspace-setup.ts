import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { IntegrationSettingsUpdate } from "../../integration-settings.ts";
import { logRouteError } from "../../security/logging.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../../services/secret-box.ts";
import { readEnv, type EnvSource } from "../../utils/env.ts";
import type { AddonDeployment } from "./addon/manifest.ts";
import { GOOGLE_SCOPES, type GoogleCredentialsSource } from "./credentials.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "./endpoints.ts";
import {
  ADDON_DEPLOYMENT_ID,
  DIRECTORY_ROLE_PRIVILEGES,
  directoryRoleName,
  executedDriveName,
  identitySentence,
  impersonationFlags,
  pickerKeyName,
  SETUP_APIS,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  workspaceAccountId,
  type SetupEvent,
  type SetupStepId,
} from "./workspace-setup-names.ts";

export {
  ADDON_DEPLOYMENT_ID,
  DIRECTORY_ROLE_PRIVILEGES,
  directoryRoleName,
  executedDriveName,
  identitySentence,
  pickerKeyName,
  SETUP_APIS,
  SETUP_CALLBACK_PATH,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  workspaceAccountId,
  workspaceProjectId,
  workspaceProjectName,
  type SetupEvent,
  type SetupProject,
  type SetupProjectChoice,
  type SetupStepId,
  type SetupStepStatus,
} from "./workspace-setup-names.ts";

// "Set everything up" for Google Workspace: one sign-in as a Workspace super
// admin, through the site's own OAuth client, grants a short-lived token;
// the server uses it to do what an administrator would otherwise click
// through in Google's consoles, then revokes it. The token is never stored.
//
// Before the steps, the administrator picks the Cloud project from the
// ones they can use (Cloud Resource Manager projects.search), or has one
// made. The steps, each safe to run again (what is already there is kept):
//
//   project. make the chosen new project, in the organization when there
//      is one (projects.create), and save which project is used;
//   a. enable the APIs the app uses (Service Usage), in that project and
//      in the projects of the sign-in client and of the site's identity;
//   identity. on Cloud Run, or with an identity set where the site runs,
//      use that. Elsewhere, make the "<app>-workspace" service account and
//      a key for it (IAM), saved encrypted. When the organization forbids
//      keys, give the administrator Service Account Token Creator on it and
//      say how to run the container with their gcloud login instead;
//   b. create the Picker's browser key, held to the Picker API and this
//      site (API Keys API), and save it with the project number;
//   c. read the Workspace customer ID (Admin SDK) and save it;
//   d. create the "<app> directory reader" admin role (Users and Groups,
//      read) and assign it to the service account (Admin SDK roles and
//      role assignments; the account's unique ID from IAM);
//   e. create the "<app> Executed" Shared Drive and make the service
//      account a Content manager (Drive), when executed copies are wanted;
//   addon. create or update the add-on's HTTP deployment (Workspace
//      Add-ons API), install it for the administrator, and save the
//      add-on's service account and client ID. Only with a public HTTPS
//      address;
//   f. run the site's own checks with its own identity.
//
// Google has no API for the OAuth consent screen, the OAuth client or the
// Marketplace listing, so those stay copy-paste steps. Each step reports
// done, skipped (already in place) or failed, with Google's status and a
// hint. Google's own error wording is not passed on: it can name accounts
// and projects.
//
// The steps are held to SETUP_TIME_BUDGET_MS, well inside the request's
// limit, so the caller always gets to revoke the token. When time runs out,
// the steps not started are named so the administrator can run it again.

export const SETUP_COOKIE = "signudoc_google_setup";
export const SETUP_COOKIE_PATH = "/api/admin/google/setup";
export const SETUP_COOKIE_MAX_AGE_SECONDS = 10 * 60;

const ROLE_MANAGEMENT_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.rolemanagement";
const CUSTOMER_READ_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.customer.readonly";

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

// The sign-in's state, PKCE verifier and choices, kept in a short-lived,
// encrypted, HttpOnly cookie between leaving for Google and coming back.

export type SetupStateCookie = {
  createdAt: number;
  exportDrive: boolean;
  returnTo: string;
  state: string;
  userId: string;
  verifier: string;
};

const STATE_CONTEXT = "signudoc/google-workspace-setup-state/v1";

export function sealSetupState(
  value: SetupStateCookie,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(
    JSON.stringify(value),
    secretKeyFor(STATE_CONTEXT, env),
  );
}

export function openSetupState(
  sealed: string | null | undefined,
  env: EnvSource = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): SetupStateCookie | null {
  if (!sealed) {
    return null;
  }

  const json = decryptPrivateKey(sealed, secretKeyFor(STATE_CONTEXT, env));

  if (!json) {
    return null;
  }

  try {
    const value = JSON.parse(json) as Partial<SetupStateCookie>;

    if (
      typeof value.state !== "string" ||
      typeof value.verifier !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.returnTo !== "string" ||
      typeof value.exportDrive !== "boolean" ||
      typeof value.createdAt !== "number" ||
      nowSeconds - value.createdAt > SETUP_COOKIE_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return value as SetupStateCookie;
  } catch {
    return null;
  }
}

export function newSetupState(): {
  challenge: string;
  state: string;
  verifier: string;
} {
  const verifier = randomBytes(48).toString("base64url");

  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(24).toString("base64url"),
    verifier,
  };
}

export function buildSetupAuthorizationUrl(input: {
  clientId: string;
  codeChallenge: string;
  exportDrive: boolean;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
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

  return `${googleUrl("https://accounts.google.com/o/oauth2/v2/auth")}?${params.toString()}`;
}

// The run.

export type SetupTestResult = { message: string; name: string; ok: boolean };

export type WorkspaceSetupInput = {
  accessToken: string;
  /** The super admin who signed in, from the ID token. */
  adminEmail: string;
  /** The add-on to deploy, or why it is not. */
  addon: { deployment: AddonDeployment } | { skipped: string };
  appName: string;
  env?: EnvSource;
  /** What is stored now, to recognise what is already set up. */
  existing: {
    addonClientId: string | null;
    addonServiceAccount: string | null;
    appId: string | null;
    cloudProject: string | null;
    customerId: string | null;
    directory: string | null;
    exportDriveId: string | null;
    pickerApiKey: string | null;
    /** The key the setup made last, to delete when it makes another. */
    serviceAccountKeyName: string | null;
  };
  exportDrive: boolean;
  /**
   * Other projects (IDs or numbers) whose APIs must be on too: the sign-in
   * client's, whose quota the setup's own calls use, and the one the
   * site's identity lives in.
   */
  extraProjects?: string[];
  fetchImpl?: typeof fetch;
  /**
   * The site's Google identity. fixed: set by where it runs (Cloud Run, or
   * GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_IMPERSONATE_SERVICE_ACCOUNT), so
   * the setup makes none. saved: one an earlier run made and saved.
   */
  identity: {
    fixed: { email: string; source: GoogleCredentialsSource } | null;
    /** A gcloud application-default login is mounted for impersonation. */
    loginAvailable: boolean;
    saved: { email: string; source: GoogleCredentialsSource } | null;
    /**
     * An identity set where the site runs that cannot be read, and the
     * account it names when known. The setup reports it and makes none.
     */
    unreadable: { email: string | null; problem: string } | null;
  };
  /** The chosen project, or the one to make. */
  project:
    | { create: false; projectId: string; projectNumber: string | null }
    | {
        create: true;
        name: string;
        /** "organizations/<id>", or null when there is no organization. */
        parent: string | null;
        projectId: string;
      };
  /**
   * When the run has to be over (ms since the epoch), counted from when
   * the caller started; SETUP_TIME_BUDGET_MS from now when not given.
   */
  deadline?: number;
  /**
   * The checks of step f, run with the site's own identity. Each check
   * starts only with CHECK_TIME_MS left before the deadline.
   */
  runTests: (state: {
    deadline: number;
    exportDriveId: string | null;
  }) => Promise<SetupTestResult[]>;
  save: (update: IntegrationSettingsUpdate) => Promise<void>;
  siteUrl: string;
  /** Waits between polls; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  emit: (event: SetupEvent) => void;
};

export class GoogleSetupError extends Error {
  readonly reason: string | null;
  readonly status: number | null;
  /** The policy constraints of a precondition failure, such as
   * constraints/iam.disableServiceAccountKeyCreation. */
  readonly violations: string[];

  constructor(
    message: string,
    status: number | null,
    reason: string | null,
    violations: string[] = [],
  ) {
    super(message);
    this.name = "GoogleSetupError";
    this.reason = reason;
    this.status = status;
    this.violations = violations;
  }
}

class StepFailure extends Error {
  readonly hint: string | undefined;
  readonly status: number | null;

  constructor(message: string, hint?: string, status: number | null = null) {
    super(message);
    this.name = "StepFailure";
    this.hint = hint;
    this.status = status;
  }
}

type Operation<T> = {
  done?: boolean;
  error?: { message?: string };
  name?: string;
  response?: T;
};

type GoogleErrorBody = {
  error?: {
    details?: Array<{
      reason?: string;
      violations?: Array<{ type?: string }>;
    }>;
    errors?: Array<{ reason?: string }>;
    message?: string;
    status?: string;
  };
};

// Right after an API is turned on, Google can answer for a minute that it
// is still off. Those answers are tried again.
const DISABLED_REASONS = new Set(["SERVICE_DISABLED", "accessNotConfigured"]);
const DISABLED_RETRIES = 12;
const DISABLED_WAIT_MS = 5000;
const OPERATION_POLLS = 30;
const OPERATION_WAIT_MS = 2000;

/**
 * How long a run may take, counted from when the route starts it: the code
 * exchange, the project list, the wait for the choice and every step. The
 * route is allowed 300 seconds, Vercel's and Cloud Run's usual limit: a
 * request already under way at the deadline (at most
 * GOOGLE_REQUEST_TIMEOUT_MS) and the revoke fit after it with room to spare.
 */
export const SETUP_TIME_BUDGET_MS = 190_000;

/**
 * The time one check of step f needs: a service account token and one
 * call, each at most GOOGLE_REQUEST_TIMEOUT_MS. A check starts only with
 * this much left, so step f ends by the deadline.
 */
export const CHECK_TIME_MS = 2 * GOOGLE_REQUEST_TIMEOUT_MS;

const RUN_AGAIN_HINT =
  "Run the setup again in a few minutes; what is done already is kept.";

/** The run's time is up: no more requests are started. */
class OutOfTime extends StepFailure {
  constructor() {
    super("The setup ran out of time.", RUN_AGAIN_HINT);
    this.name = "OutOfTime";
  }
}

function isDisabled(error: unknown): boolean {
  return (
    error instanceof GoogleSetupError &&
    error.status === 403 &&
    DISABLED_REASONS.has(error.reason ?? "")
  );
}

function createClient(
  input: Pick<
    WorkspaceSetupInput,
    "accessToken" | "env" | "fetchImpl" | "sleep"
  >,
  deadline: number,
) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const env = input.env ?? process.env;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Waits, unless that would pass the deadline. */
  async function wait(ms: number) {
    if (Date.now() + ms >= deadline) {
      throw new OutOfTime();
    }

    await sleep(ms);
  }

  async function once<T>(
    method: string,
    url: string,
    body: unknown,
  ): Promise<T> {
    if (Date.now() >= deadline) {
      throw new OutOfTime();
    }

    let response: Response;

    try {
      response = await fetchImpl(googleUrl(url, env), {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        signal: googleTimeoutSignal(GOOGLE_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleSetupError("Google could not be reached.", null, null);
    }

    if (response.ok) {
      return (
        response.status === 204 ? {} : await response.json().catch(() => ({}))
      ) as T;
    }

    const payload = (await response
      .json()
      .catch(() => null)) as GoogleErrorBody | null;
    const reason =
      payload?.error?.details?.find((detail) => detail.reason)?.reason ??
      payload?.error?.errors?.[0]?.reason ??
      payload?.error?.status ??
      null;

    // Only the status and the reason code: Google's message can name
    // accounts and projects.
    throw new GoogleSetupError(
      `Google answered ${String(response.status)}.`,
      response.status,
      reason,
      (payload?.error?.details ?? []).flatMap((detail) =>
        (detail.violations ?? []).flatMap((violation) =>
          violation.type ? [violation.type] : [],
        ),
      ),
    );
  }

  async function call<T>(method: string, url: string, body?: unknown) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once<T>(method, url, body);
      } catch (error) {
        if (isDisabled(error) && attempt < DISABLED_RETRIES) {
          await wait(DISABLED_WAIT_MS);
          continue;
        }

        throw error;
      }
    }
  }

  /** Waits for a long-running operation and returns its response. */
  async function finish<T>(
    base: string,
    operation: Operation<T>,
  ): Promise<T | undefined> {
    let current = operation;

    for (let poll = 0; !current.done; poll += 1) {
      if (poll >= OPERATION_POLLS || !current.name) {
        throw new StepFailure(
          "Google is still working on it.",
          "Run the setup again in a minute; what is done already is kept.",
        );
      }

      await wait(OPERATION_WAIT_MS);
      current = await call<typeof operation>("GET", `${base}/${current.name}`);
    }

    if (current.error) {
      throw new StepFailure("Google reported an error.");
    }

    return current.response;
  }

  return { call, finish, wait };
}

const STILL_TURNING_ON =
  "Google is still turning this API on, which can take a few minutes after step a.";

/** Logs a failure that is not Google's answer, such as a database error. */
function logUnexpected(error: unknown) {
  logRouteError(error, {
    category: "google_workspace_setup_failure",
    message: "Unexpected failure in a step of the automatic Google setup.",
  });
}

/** A failure as the page is told it: our own words and Google's status. */
function toStepFailure(
  error: unknown,
  hints: Partial<Record<number, string>> = {},
): StepFailure {
  if (error instanceof StepFailure) {
    return error;
  }

  if (error instanceof GoogleSetupError) {
    return new StepFailure(
      isDisabled(error)
        ? STILL_TURNING_ON
        : error.status === null
          ? error.message
          : "Google refused the request.",
      isDisabled(error)
        ? RUN_AGAIN_HINT
        : ((error.status !== null ? hints[error.status] : undefined) ??
            (error.status === 401
              ? "The sign-in expired. Run the setup again."
              : undefined)),
      error.status,
    );
  }

  logUnexpected(error);

  return new StepFailure("Something went wrong.");
}

function fail(error: unknown, hints: Partial<Record<number, string>>): never {
  throw toStepFailure(error, hints);
}

const PROJECT_HINT =
  "Sign in with an account that is an Owner of the Cloud project, or has Service Usage Admin, API Keys Admin, Service Account Admin and Service Account Key Admin on it.";
const SUPER_ADMIN_HINT = "Sign in with a Workspace super admin account.";
const KEY_REFUSED_CONSTRAINT =
  "constraints/iam.disableServiceAccountKeyCreation";
// Google holds a service account to this many user-managed keys.
const MAX_ACCOUNT_KEYS = 10;
// A service account just made can be "not found" for a few seconds.
const NEW_ACCOUNT_RETRIES = 6;
const NEW_ACCOUNT_WAIT_MS = 5000;

type ServiceState = {
  config?: { name?: string };
  name?: string;
  state?: string;
};

type ApiKey = {
  displayName?: string;
  name: string;
  restrictions?: {
    apiTargets?: Array<{ service?: string }>;
    browserKeyRestrictions?: { allowedReferrers?: string[] };
  };
};

type Privilege = {
  childPrivileges?: Privilege[];
  privilegeName?: string;
  serviceId?: string;
};

type IamPolicy = {
  bindings?: Array<{ condition?: unknown; members?: string[]; role?: string }>;
  etag?: string;
  version?: number;
};

type Deployment = {
  addOns?: unknown;
  etag?: string;
  name?: string;
  oauthScopes?: string[];
};

function findPrivileges(
  items: readonly Privilege[],
  names: readonly string[],
): Array<{ privilegeName: string; serviceId: string }> {
  const found = new Map<string, string>();
  const visit = (list: readonly Privilege[]) => {
    for (const item of list) {
      if (
        item.privilegeName &&
        item.serviceId &&
        names.includes(item.privilegeName) &&
        !found.has(item.privilegeName)
      ) {
        found.set(item.privilegeName, item.serviceId);
      }

      visit(item.childPrivileges ?? []);
    }
  };

  visit(items);

  return names
    .filter((name) => found.has(name))
    .map((name) => ({ privilegeName: name, serviceId: found.get(name)! }));
}

/** JSON with object keys in order, to compare what Google gives back. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/** True when the organization refused to make a service account key. */
export function isKeyCreationRefused(error: unknown): boolean {
  return (
    error instanceof GoogleSetupError &&
    error.violations.includes(KEY_REFUSED_CONSTRAINT)
  );
}

type RunState = {
  deadline: number;
  outOfTime: boolean;
  started: Set<SetupStepId>;
};

/**
 * Runs the steps, reporting each as it goes. Returns whether every step
 * ended done or skipped. The token is revoked by the caller.
 */
export async function runWorkspaceSetup(
  input: WorkspaceSetupInput,
): Promise<boolean> {
  const state: RunState = {
    deadline: input.deadline ?? Date.now() + SETUP_TIME_BUDGET_MS,
    outOfTime: false,
    started: new Set(),
  };
  // The page may have gone away (a closed tab): the run carries on, so it
  // ends between steps rather than half-way through one.
  const emit = (event: SetupEvent) => {
    try {
      input.emit(event);
    } catch {
      // Nobody is reading any more.
    }
  };
  const ok = await runSteps({ ...input, emit }, state);

  if (state.outOfTime) {
    const notRun = SETUP_STEP_ORDER.filter((id) => !state.started.has(id));

    emit({
      hint: RUN_AGAIN_HINT,
      message:
        notRun.length > 0
          ? `The setup ran out of time before: ${notRun.map((id) => SETUP_STEP_TITLES[id]).join("; ")}.`
          : "The setup ran out of time.",
      type: "refused",
    });
    return false;
  }

  return ok;
}

async function runSteps(
  input: WorkspaceSetupInput,
  state: RunState,
): Promise<boolean> {
  const env = input.env ?? process.env;
  const { call, finish, wait } = createClient(input, state.deadline);
  const projectId = input.project.projectId;
  const origin = new URL(input.siteUrl).origin;
  let ok = true;
  let projectNumber = input.project.create ? null : input.project.projectNumber;
  let customerId: string | null = null;
  let exportDriveId = input.existing.exportDriveId;
  let serviceAccountEmail: string | null = input.identity.fixed?.email ?? null;
  // A service account the run just made, which Google can take a moment
  // to find.
  let accountIsNew = false;
  const project = () => projectNumber ?? projectId;

  async function step(
    id: SetupStepId,
    run: () => Promise<{ detail: string; skipped?: boolean }>,
    /** How much time has to be left for the step to be started. */
    needsMs = 0,
  ): Promise<boolean> {
    const title = SETUP_STEP_TITLES[id];

    if (state.outOfTime || Date.now() + needsMs >= state.deadline) {
      state.outOfTime = true;
      ok = false;
      return false;
    }

    state.started.add(id);
    input.emit({ detail: "", id, status: "running", title, type: "step" });

    try {
      const result = await run();

      input.emit({
        detail: result.detail,
        id,
        status: result.skipped ? "skipped" : "done",
        title,
        type: "step",
      });

      return true;
    } catch (error) {
      const failure = toStepFailure(error);

      if (error instanceof OutOfTime) {
        state.outOfTime = true;
      }

      ok = false;
      input.emit({
        detail: failure.message,
        googleStatus: failure.status,
        hint: failure.hint,
        id,
        status: "failed",
        title,
        type: "step",
      });

      return false;
    }
  }

  /** Tries again while a service account just made is not found yet. */
  async function whileNew<T>(fresh: boolean, request: () => Promise<T>) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        if (
          fresh &&
          error instanceof GoogleSetupError &&
          error.status === 404 &&
          attempt < NEW_ACCOUNT_RETRIES
        ) {
          await wait(NEW_ACCOUNT_WAIT_MS);
          continue;
        }

        throw error;
      }
    }
  }

  // The project: a new one is made, a chosen one is only saved.
  const projectOk = await step("project", async () => {
    if (!input.project.create) {
      if (input.existing.cloudProject !== projectId) {
        await input.save({ "google.cloudProject": projectId });

        return { detail: `Uses ${projectId}, and saved it.` };
      }

      return { detail: `Uses ${projectId}.`, skipped: true };
    }

    const { name, parent } = input.project;

    try {
      const created = await finish<{ name?: string }>(
        "https://cloudresourcemanager.googleapis.com/v3",
        await call<Operation<{ name?: string }>>(
          "POST",
          "https://cloudresourcemanager.googleapis.com/v3/projects",
          { displayName: name, projectId, ...(parent ? { parent } : {}) },
        ),
      );

      projectNumber = created?.name?.split("/")[1] ?? null;
    } catch (error) {
      fail(error, {
        403: "This account may not make projects. Ask for Project Creator in the organization, or choose a project that is there already.",
        409: "A project with that ID is there already. Run the setup again to try another.",
      });
    }

    await input.save({ "google.cloudProject": projectId });

    return {
      detail: `Created "${name}" (${projectId})${parent ? " in your organization" : ""}, and saved it. It needs no billing account.`,
    };
  });

  if (!projectOk) {
    return false;
  }

  // a. APIs, in the chosen project and the others the setup and the site
  // call Google through. A 403 here means the account cannot change a
  // project, and nothing else can be done either.
  const apisOk = await step("apis", async () => {
    const targets = [
      project(),
      ...(input.extraProjects ?? []).filter(
        (other) => other !== projectId && other !== projectNumber,
      ),
    ].filter((value, index, all) => all.indexOf(value) === index);
    const turnedOn: string[] = [];

    for (const target of targets) {
      const servicesBase = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(target)}`;
      let states: ServiceState[];

      try {
        const names = SETUP_APIS.map(
          (api) =>
            `names=${encodeURIComponent(`projects/${target}/services/${api}`)}`,
        ).join("&");

        states =
          (
            await call<{ services?: ServiceState[] }>(
              "GET",
              `${servicesBase}/services:batchGet?${names}`,
            )
          ).services ?? [];
      } catch (error) {
        fail(error, { 403: PROJECT_HINT, 404: "Check the Cloud project." });
      }

      const enabled = new Set(
        states
          .filter((service) => service.state === "ENABLED")
          .map(
            (service) => service.config?.name ?? service.name?.split("/").pop(),
          ),
      );
      const missing = SETUP_APIS.filter((api) => !enabled.has(api));

      if (missing.length === 0) {
        continue;
      }

      try {
        await finish(
          "https://serviceusage.googleapis.com/v1",
          await call<Operation<unknown>>(
            "POST",
            `${servicesBase}/services:batchEnable`,
            { serviceIds: missing },
          ),
        );
      } catch (error) {
        fail(error, {
          403: PROJECT_HINT,
          400: "Google refused to turn an API on. None of these APIs needs billing; check the project in the Cloud console.",
        });
      }

      turnedOn.push(
        targets.length > 1
          ? `${missing.join(", ")} in ${target === project() ? projectId : target}`
          : missing.join(", "),
      );
    }

    return turnedOn.length === 0
      ? {
          detail: `All ${String(SETUP_APIS.length)} APIs were already on.`,
          skipped: true,
        }
      : { detail: `Turned on ${turnedOn.join("; ")}.` };
  });

  if (!apisOk) {
    return false;
  }

  // Every later step needs a super admin. Asked once the Admin SDK is on.
  let isSuperAdmin = false;

  try {
    isSuperAdmin =
      (
        await call<{ isAdmin?: boolean }>(
          "GET",
          `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.adminEmail)}?fields=isAdmin`,
        )
      ).isAdmin === true;
  } catch (error) {
    if (error instanceof OutOfTime) {
      state.outOfTime = true;
      return false;
    }

    // A 403 that says the API is off is not an answer about the account.
    if (isDisabled(error)) {
      input.emit({
        hint: RUN_AGAIN_HINT,
        message:
          "The Admin SDK API is still being turned on, so it could not say whether this account is a super admin yet.",
        type: "refused",
      });
      return false;
    }

    if (!(error instanceof GoogleSetupError) || error.status !== 403) {
      input.emit({
        hint: SUPER_ADMIN_HINT,
        message: `Could not check that ${input.adminEmail} is a super admin: ${error instanceof GoogleSetupError ? error.message : toStepFailure(error).message}`,
        type: "refused",
      });
      return false;
    }
  }

  if (!isSuperAdmin) {
    input.emit({
      hint: SUPER_ADMIN_HINT,
      message: `${input.adminEmail} is not a Workspace super admin, so the directory role, customer ID and Shared Drive cannot be set up with it.`,
      type: "refused",
    });
    return false;
  }

  // The site's own identity. Where the site runs decides it when it can;
  // otherwise a service account of its own, with a key or impersonated.
  await step("identity", async () => {
    const { fixed, loginAvailable, saved, unreadable } = input.identity;

    if (fixed) {
      return { detail: identitySentence(fixed), skipped: true };
    }

    if (unreadable) {
      serviceAccountEmail = unreadable.email;

      throw new StepFailure(
        unreadable.problem,
        "Fix it where the site runs (GOOGLE_SERVICE_ACCOUNT_KEY, or GOOGLE_IMPERSONATE_SERVICE_ACCOUNT and the mounted gcloud login), then run the setup again. No account or key was made.",
      );
    }

    const email = `${workspaceAccountId(input.appName)}@${projectId}.iam.gserviceaccount.com`;
    const accountUrl = `https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(email)}`;
    let created = false;

    try {
      created = await call("GET", accountUrl).then(
        () => false,
        async (error: unknown) => {
          if (!(error instanceof GoogleSetupError) || error.status !== 404) {
            throw error;
          }

          await call(
            "POST",
            `https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
            {
              accountId: workspaceAccountId(input.appName),
              serviceAccount: {
                description: `${input.appName} reads the Workspace directory and keeps executed copies in Drive as this account.`,
                displayName: `${input.appName} Workspace`.slice(0, 100),
              },
            },
          ).catch((createError: unknown) => {
            // Made by a run at the same moment, or just now.
            if (
              !(createError instanceof GoogleSetupError) ||
              createError.status !== 409
            ) {
              throw createError;
            }
          });

          return true;
        },
      );
    } catch (error) {
      fail(error, { 403: PROJECT_HINT });
    }

    serviceAccountEmail = email;
    accountIsNew = created;

    if (saved?.email === email) {
      return {
        detail: created
          ? `Made ${email} again. ${identitySentence(saved)}`
          : identitySentence(saved),
        skipped: !created,
      };
    }

    // The key an earlier run made is not in use (the site would be using
    // this account if it were), so it goes before a new one is made, and
    // keys do not pile up towards Google's limit.
    const previous = input.existing.serviceAccountKeyName;
    const keyIdOf = (name: string | undefined) =>
      name?.split("/keys/")[1] ?? null;
    let keys: string[];

    try {
      keys = (
        (
          await whileNew(created, () =>
            call<{ keys?: Array<{ name?: string }> }>(
              "GET",
              `${accountUrl}/keys?keyTypes=USER_MANAGED`,
            ),
          )
        ).keys ?? []
      )
        .map((item) => keyIdOf(item.name))
        .filter((id): id is string => Boolean(id));

      const previousId = keyIdOf(previous ?? undefined);

      if (
        previous &&
        previousId &&
        previous.includes(`/serviceAccounts/${email}/keys/`) &&
        keys.includes(previousId)
      ) {
        await call(
          "DELETE",
          `https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(email)}/keys/${encodeURIComponent(previousId)}`,
        );
        keys = keys.filter((id) => id !== previousId);
      }
    } catch (error) {
      fail(error, { 403: PROJECT_HINT });
    }

    if (keys.length >= MAX_ACCOUNT_KEYS) {
      throw new StepFailure(
        `${email} already has ${String(MAX_ACCOUNT_KEYS)} keys, Google's limit, so no new one can be made.`,
        `Delete the keys it no longer needs (Cloud console, IAM and admin, Service accounts, ${email}, Keys), then run the setup again.`,
      );
    }

    let made: { name?: string; privateKeyData?: string };

    try {
      made = await whileNew(created, () =>
        call<{ name?: string; privateKeyData?: string }>(
          "POST",
          `${accountUrl}/keys`,
          {
            keyAlgorithm: "KEY_ALG_RSA_2048",
            privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
          },
        ),
      );
    } catch (error) {
      if (!isKeyCreationRefused(error)) {
        fail(error, { 403: PROJECT_HINT });
      }

      // No key may be made here: the administrator's gcloud login acts as
      // the account instead, so it is given Token Creator on it.
      try {
        await grantTokenCreator(accountUrl, created);
      } catch (grantError) {
        fail(grantError, { 403: PROJECT_HINT });
      }

      // A key that works now is kept until the login it would give way to
      // is there.
      const keepKey = saved?.source === "stored-key" && !loginAvailable;

      await input.save({
        "google.impersonateServiceAccount": email,
        ...(keepKey
          ? {}
          : {
              "google.serviceAccountKey": null,
              "google.serviceAccountKeyName": null,
            }),
      });

      if (!keepKey && previous) {
        await deleteKeyQuietly(previous);
      }

      throw new StepFailure(
        `Made ${email}, but your organization does not allow service account keys (${KEY_REFUSED_CONSTRAINT}), so no key was made. ${input.adminEmail} can now act as it.${keepKey && saved ? ` The site keeps using the stored key for ${saved.email} until your gcloud login is mounted.` : ""}`,
        `Run gcloud auth application-default login as ${input.adminEmail}, then start the container with ${impersonationFlags(email)}${keepKey ? " and run the setup again to switch" : ""}. The rest of the setup uses this account. Or allow keys for this project in the organization policy and run the setup again.`,
        error instanceof GoogleSetupError ? error.status : null,
      );
    }

    const key = made.privateKeyData
      ? Buffer.from(made.privateKeyData, "base64").toString("utf8")
      : "";

    if (!key.includes('"private_key"')) {
      throw new StepFailure("Google did not return the new key.");
    }

    await input.save({
      "google.impersonateServiceAccount": null,
      "google.serviceAccountKey": key,
      "google.serviceAccountKeyName": made.name ?? null,
    });

    // A key an earlier run made for another account is not used any more.
    if (previous && !previous.includes(`/serviceAccounts/${email}/keys/`)) {
      await deleteKeyQuietly(previous);
    }

    return {
      detail: `${created ? "Made" : "Found"} ${email}, made a key for it and stored it encrypted. ${identitySentence({ email, source: "stored-key" })}`,
    };
  });

  /** Deletes a key the setup made before; one already gone is fine. */
  async function deleteKeyQuietly(name: string) {
    try {
      await call("DELETE", `https://iam.googleapis.com/v1/${name}`);
    } catch {
      // Left for the administrator; the console lists it.
    }
  }

  /**
   * Gives the administrator Service Account Token Creator on the account.
   * The policy is read as version 3 so conditional bindings are kept, and
   * written once more if someone changed it in between.
   */
  async function grantTokenCreator(accountUrl: string, fresh: boolean) {
    const role = "roles/iam.serviceAccountTokenCreator";
    const member = `user:${input.adminEmail}`;

    for (let attempt = 0; ; attempt += 1) {
      const policy = await whileNew(fresh, () =>
        call<IamPolicy>("POST", `${accountUrl}:getIamPolicy`, {
          options: { requestedPolicyVersion: 3 },
        }),
      );
      const bindings = policy.bindings ?? [];
      const binding = bindings.find(
        (item) => item.role === role && !item.condition,
      );

      if (binding?.members?.includes(member)) {
        return;
      }

      const conditional = bindings.some((item) => item.condition);

      try {
        await call("POST", `${accountUrl}:setIamPolicy`, {
          policy: {
            ...policy,
            bindings: binding
              ? bindings.map((item) =>
                  item === binding
                    ? { ...item, members: [...(item.members ?? []), member] }
                    : item,
                )
              : [...bindings, { members: [member], role }],
            ...(conditional ? { version: 3 } : {}),
          },
        });
        return;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof GoogleSetupError &&
          error.status === 409
        ) {
          continue;
        }

        throw error;
      }
    }
  }

  const noAccount = () =>
    new StepFailure(
      "There is no service account to give it to.",
      "Fix the step that gives the site its identity, then run the setup again.",
    );

  // b. The Picker's key.
  await step("picker", async () => {
    if (readEnv(env, "GOOGLE_PICKER_API_KEY")) {
      return {
        detail: "GOOGLE_PICKER_API_KEY is set where the site runs.",
        skipped: true,
      };
    }

    const keysBase = `https://apikeys.googleapis.com/v2/projects/${encodeURIComponent(project())}/locations/global/keys`;
    const displayName = pickerKeyName(input.appName);
    const restrictions = {
      apiTargets: [{ service: "picker.googleapis.com" }],
      browserKeyRestrictions: { allowedReferrers: [`${origin}/*`] },
    };

    try {
      if (!projectNumber) {
        const found = await call<{ projectNumber?: string }>(
          "GET",
          `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
        );

        projectNumber = found.projectNumber ?? null;
      }

      const keys: ApiKey[] = [];
      let pageToken = "";

      do {
        const page = await call<{ keys?: ApiKey[]; nextPageToken?: string }>(
          "GET",
          `${keysBase}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );

        keys.push(...(page.keys ?? []));
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);

      let key = keys.find((item) => item.displayName === displayName);
      let created = false;
      let restricted = false;

      if (!key) {
        key = await finish<ApiKey>(
          "https://apikeys.googleapis.com/v2",
          await call<Operation<ApiKey>>("POST", keysBase, {
            displayName,
            restrictions,
          }),
        );

        if (!key?.name) {
          throw new StepFailure("Google did not say which key it made.");
        }

        created = true;
      } else if (
        JSON.stringify(key.restrictions?.apiTargets?.map((t) => t.service)) !==
          JSON.stringify(["picker.googleapis.com"]) ||
        !key.restrictions?.browserKeyRestrictions?.allowedReferrers?.includes(
          `${origin}/*`,
        )
      ) {
        await finish(
          "https://apikeys.googleapis.com/v2",
          await call<Operation<ApiKey>>(
            "PATCH",
            `https://apikeys.googleapis.com/v2/${key.name}?updateMask=restrictions`,
            { restrictions },
          ),
        );
        restricted = true;
      }

      const { keyString } = await call<{ keyString?: string }>(
        "GET",
        `https://apikeys.googleapis.com/v2/${key.name}/keyString`,
      );

      if (!keyString) {
        throw new StepFailure("Google did not return the key.");
      }

      const unchanged =
        !created &&
        !restricted &&
        input.existing.pickerApiKey === keyString &&
        input.existing.appId === projectNumber;

      if (!unchanged) {
        await input.save({
          "drive.pickerApiKey": keyString,
          ...(projectNumber && !readEnv(env, "GOOGLE_DRIVE_APP_ID")
            ? { "drive.appId": projectNumber }
            : {}),
        });
      }

      // The Picker does not open without the app ID, the project number.
      if (
        !projectNumber &&
        !input.existing.appId &&
        !readEnv(env, "GOOGLE_DRIVE_APP_ID")
      ) {
        throw new StepFailure(
          `Saved "${displayName}", but Google did not say the Cloud project's number, which the Picker needs as its app ID.`,
          "Copy the project number from the project's dashboard in the Cloud console into Google Drive settings, or set GOOGLE_DRIVE_APP_ID where the site runs.",
        );
      }

      return unchanged
        ? { detail: `"${displayName}" was already in place.`, skipped: true }
        : {
            detail: created
              ? `Created "${displayName}", held to the Picker API and ${origin}, and saved it.`
              : `Saved "${displayName}"${restricted ? ", held again to the Picker API and this site" : ""}.`,
          };
    } catch (error) {
      fail(error, { 403: PROJECT_HINT });
    }
  });

  // c. The customer ID.
  await step("customer", async () => {
    try {
      const customer = await call<{ id?: string }>(
        "GET",
        "https://admin.googleapis.com/admin/directory/v1/customers/my_customer",
      );

      if (!customer.id) {
        throw new StepFailure("Google did not return a customer ID.");
      }

      customerId = customer.id;
    } catch (error) {
      fail(error, { 403: SUPER_ADMIN_HINT });
    }

    if (readEnv(env, "GOOGLE_WORKSPACE_CUSTOMER_ID")) {
      return {
        detail: `${customerId}. GOOGLE_WORKSPACE_CUSTOMER_ID is set where the site runs, so it is used instead.`,
        skipped: true,
      };
    }

    if (input.existing.customerId === customerId) {
      return { detail: `${customerId} was already saved.`, skipped: true };
    }

    await input.save({ "google.customerId": customerId });

    return { detail: `Saved ${customerId}.` };
  });

  // d. The directory role.
  await step("role", async () => {
    const account = serviceAccountEmail;

    if (!account) {
      throw noAccount();
    }

    const encodedEmail = encodeURIComponent(account);
    const customer = customerId ?? "my_customer";
    const rolesBase = `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(customer)}`;
    const roleName = directoryRoleName(input.appName);
    let uniqueId: string;
    let roleId: string | null = null;
    let createdRole = false;

    try {
      const found = await whileNew(accountIsNew, () =>
        call<{ uniqueId?: string }>(
          "GET",
          `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodedEmail}`,
        ),
      );

      if (!found.uniqueId) {
        throw new StepFailure("IAM did not return the service account's ID.");
      }

      uniqueId = found.uniqueId;
    } catch (error) {
      fail(error, {
        403: PROJECT_HINT,
        404: "The service account was not found in this project.",
      });
    }

    try {
      let pageToken = "";

      do {
        const page = await call<{
          items?: Array<{ roleId?: string; roleName?: string }>;
          nextPageToken?: string;
        }>(
          "GET",
          `${rolesBase}/roles?maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );

        roleId =
          page.items?.find((role) => role.roleName === roleName)?.roleId ??
          null;
        pageToken = roleId ? "" : (page.nextPageToken ?? "");
      } while (pageToken);

      if (!roleId) {
        const privileges = await call<{ items?: Privilege[] }>(
          "GET",
          `${rolesBase}/roles/ALL/privileges`,
        );
        const rolePrivileges = findPrivileges(
          privileges.items ?? [],
          DIRECTORY_ROLE_PRIVILEGES,
        );

        if (rolePrivileges.length !== DIRECTORY_ROLE_PRIVILEGES.length) {
          throw new StepFailure(
            "Google did not offer the Users and Groups read privileges.",
            "Create the role by hand: Admin console, Account, Admin roles.",
          );
        }

        const role = await call<{ roleId?: string }>(
          "POST",
          `${rolesBase}/roles`,
          {
            roleDescription: `Lets ${input.appName} read users and groups to suggest recipients and check administrators.`,
            roleName,
            rolePrivileges,
          },
        );

        roleId = role.roleId ?? null;
        createdRole = true;

        if (!roleId) {
          throw new StepFailure("Google did not say which role it made.");
        }
      }

      let assigned = false;
      let assignmentToken = "";

      do {
        const page = await call<{
          items?: Array<{ assignedTo?: string }>;
          nextPageToken?: string;
        }>(
          "GET",
          `${rolesBase}/roleassignments?roleId=${encodeURIComponent(roleId)}&maxResults=200${assignmentToken ? `&pageToken=${encodeURIComponent(assignmentToken)}` : ""}`,
        );

        assigned =
          page.items?.some((item) => item.assignedTo === uniqueId) ?? false;
        assignmentToken = assigned ? "" : (page.nextPageToken ?? "");
      } while (assignmentToken);

      if (assigned && !createdRole) {
        await turnDirectoryOn();

        return {
          detail: `"${roleName}" was already assigned to ${account}.`,
          skipped: true,
        };
      }

      if (!assigned) {
        await call("POST", `${rolesBase}/roleassignments`, {
          assignedTo: uniqueId,
          roleId,
          scopeType: "CUSTOMER",
        });
      }

      await turnDirectoryOn();

      return {
        detail: `${createdRole ? "Created" : "Found"} "${roleName}" (Users and Groups, read) and assigned it to ${account}.`,
      };
    } catch (error) {
      fail(error, { 403: SUPER_ADMIN_HINT });
    }
  });

  // Suggestions from the directory come on with the role, unless they were
  // turned off on purpose or are fixed by the environment.
  async function turnDirectoryOn() {
    if (
      input.existing.directory === null &&
      !readEnv(env, "GOOGLE_WORKSPACE_DIRECTORY")
    ) {
      await input.save({ "google.directory": "on" });
    }
  }

  // e. The Shared Drive. Only the one this site saved is used again: a
  // Shared Drive is not found by its name, since anyone in the
  // organization can make one called that.
  await step("drive", async () => {
    const account = serviceAccountEmail;

    if (!account) {
      throw noAccount();
    }

    const fromEnv = readEnv(env, "GOOGLE_DRIVE_EXPORT_DRIVE_ID");

    if (fromEnv) {
      exportDriveId = fromEnv;

      return {
        detail: "GOOGLE_DRIVE_EXPORT_DRIVE_ID is set where the site runs.",
        skipped: true,
      };
    }

    if (!input.exportDrive) {
      return {
        detail:
          "Executed copies are not kept in a Shared Drive. Turn it on in Google Drive settings later.",
        skipped: true,
      };
    }

    const name = executedDriveName(input.appName);
    const driveBase = "https://www.googleapis.com/drive/v3";
    // One per run, so a request Google is asked again (after a "still
    // turning on" answer) makes one drive, not two.
    const requestId = randomUUID();
    let driveId: string | null = null;
    let createdDrive = false;

    try {
      if (exportDriveId) {
        const found = await call<{ id?: string }>(
          "GET",
          `${driveBase}/drives/${encodeURIComponent(exportDriveId)}?useDomainAdminAccess=true&fields=id`,
        ).catch((error: unknown) => {
          if (error instanceof GoogleSetupError && error.status === 404) {
            return { id: undefined };
          }

          throw error;
        });

        driveId = found.id ?? null;
      }

      if (!driveId) {
        const drive = await call<{ id?: string }>(
          "POST",
          `${driveBase}/drives?requestId=${requestId}`,
          { name },
        );

        driveId = drive.id ?? null;
        createdDrive = true;

        if (!driveId) {
          throw new StepFailure(
            "Google did not say which Shared Drive it made.",
          );
        }
      }

      const membersUrl = `${driveBase}/files/${encodeURIComponent(driveId)}/permissions?supportsAllDrives=true&useDomainAdminAccess=true`;
      let member: { emailAddress?: string; role?: string } | undefined;
      let membersToken = "";

      do {
        const page = await call<{
          nextPageToken?: string;
          permissions?: Array<{ emailAddress?: string; role?: string }>;
        }>(
          "GET",
          `${membersUrl}&pageSize=100&fields=nextPageToken,permissions(id,type,role,emailAddress)${membersToken ? `&pageToken=${encodeURIComponent(membersToken)}` : ""}`,
        );

        member = page.permissions?.find(
          (permission) =>
            permission.emailAddress?.toLowerCase() === account.toLowerCase(),
        );
        membersToken = member ? "" : (page.nextPageToken ?? "");
      } while (membersToken);

      const canAdd =
        member?.role === "organizer" || member?.role === "fileOrganizer";

      if (!canAdd) {
        await call("POST", `${membersUrl}&sendNotificationEmail=false`, {
          emailAddress: account,
          role: "fileOrganizer",
          type: "user",
        });
      }

      exportDriveId = driveId;

      if (input.existing.exportDriveId !== driveId) {
        await input.save({ "drive.exportDriveId": driveId });
      }

      return canAdd && !createdDrive && input.existing.exportDriveId === driveId
        ? {
            detail: `"${name}" was already in place, with the service account as Content manager.`,
            skipped: true,
          }
        : {
            detail: `${createdDrive ? "Created" : "Found"} "${name}", made ${account} a Content manager, and saved it.`,
          };
    } catch (error) {
      fail(error, {
        403: "Shared Drives may be turned off for your organization, or this account cannot create them (Admin console, Apps, Google Workspace, Drive and Docs, Sharing settings).",
      });
    }
  });

  // The add-on: its HTTP deployment in the project, installed for the
  // administrator. Everyone else gets it through the Marketplace listing.
  await step("addon", async () => {
    if ("skipped" in input.addon) {
      return { detail: input.addon.skipped, skipped: true };
    }

    const { deployment } = input.addon;
    const base = `https://gsuiteaddons.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;
    const deploymentUrl = `${base}/deployments/${ADDON_DEPLOYMENT_ID}`;
    let action: "created" | "kept" | "updated";
    let installed = false;
    let authorization: { oauthClientId?: string; serviceAccountEmail?: string };

    try {
      const current = await call<Deployment>("GET", deploymentUrl).catch(
        (error: unknown) => {
          if (error instanceof GoogleSetupError && error.status === 404) {
            return null;
          }

          throw error;
        },
      );

      if (!current) {
        await call(
          "POST",
          `${base}/deployments?deploymentId=${ADDON_DEPLOYMENT_ID}`,
          deployment,
        );
        action = "created";
      } else if (
        stableJson(current.addOns) !== stableJson(deployment.addOns) ||
        stableJson(current.oauthScopes) !== stableJson(deployment.oauthScopes)
      ) {
        await call("PUT", deploymentUrl, {
          ...deployment,
          ...(current.etag ? { etag: current.etag } : {}),
          name: `projects/${projectId}/deployments/${ADDON_DEPLOYMENT_ID}`,
        });
        action = "updated";
      } else {
        action = "kept";
      }

      const status = await call<{ installed?: boolean }>(
        "GET",
        `${deploymentUrl}/installStatus`,
      );

      if (!status.installed) {
        await call("POST", `${deploymentUrl}:install`, {});
        installed = true;
      }

      authorization = await call("GET", `${base}/authorization`);
    } catch (error) {
      fail(error, { 403: PROJECT_HINT });
    }

    const update: IntegrationSettingsUpdate = {};

    if (
      authorization.serviceAccountEmail &&
      !readEnv(env, "GOOGLE_ADDON_SERVICE_ACCOUNT") &&
      input.existing.addonServiceAccount !== authorization.serviceAccountEmail
    ) {
      update["google.addonServiceAccount"] = authorization.serviceAccountEmail;
    }

    if (
      authorization.oauthClientId &&
      !readEnv(env, "GOOGLE_ADDON_CLIENT_ID") &&
      input.existing.addonClientId !== authorization.oauthClientId
    ) {
      update["google.addonClientId"] = authorization.oauthClientId;
    }

    if (Object.keys(update).length > 0) {
      await input.save(update);
    }

    if (action === "kept" && !installed && Object.keys(update).length === 0) {
      return {
        detail: `The deployment "${ADDON_DEPLOYMENT_ID}" was already in place and installed for you.`,
        skipped: true,
      };
    }

    return {
      detail: `${action === "created" ? "Created" : action === "updated" ? "Updated" : "Kept"} the deployment "${ADDON_DEPLOYMENT_ID}"${installed ? ", installed it for you" : ""}${Object.keys(update).length > 0 ? ", and saved the add-on's service account and client ID" : ""}. To give it to everyone, finish the Marketplace listing.`,
    };
  });

  // f. The site's own checks.
  await step(
    "tests",
    async () => {
      const results = await input.runTests({
        deadline: state.deadline,
        exportDriveId,
      });
      const failed = results.filter((result) => !result.ok);

      if (failed.length > 0) {
        throw new StepFailure(
          failed.map((result) => `${result.name}: ${result.message}`).join(" "),
          "Google can take a few minutes to apply a new role, key or Shared Drive member. Run the tests again from Settings in a little while.",
        );
      }

      return {
        detail: results
          .map((result) => `${result.name}: ${result.message}`)
          .join(" "),
      };
    },
    CHECK_TIME_MS,
  );

  return ok;
}

// Before the steps: the projects the administrator can choose from.

const PROJECT_PAGES = 5;

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
  projects: Array<{ name: string; number: string | null; projectId: string }>;
}> {
  const { call, finish } = createClient(input, input.deadline);
  const crm = "cloudresourcemanager.googleapis.com";

  if (input.clientProject) {
    const services = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(input.clientProject)}/services/${crm}`;

    try {
      const current = await call<{ state?: string }>("GET", services);

      if (current.state !== "ENABLED") {
        await finish(
          "https://serviceusage.googleapis.com/v1",
          await call<Operation<unknown>>("POST", `${services}:enable`, {}),
        );
      }
    } catch {
      // Listing says what is wrong, if anything is.
    }
  }

  const projects: Array<{
    name: string;
    number: string | null;
    projectId: string;
  }> = [];
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
    const failure = toStepFailure(error, {
      403: "This account cannot list Cloud projects. A new project can still be made.",
    });

    problem = [failure.message, failure.hint].filter(Boolean).join(" ");
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
