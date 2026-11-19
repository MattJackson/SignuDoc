import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { IntegrationSettingsUpdate } from "../../integration-settings.ts";
import { logRouteError } from "../../security/logging.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../../services/secret-box.ts";
import { readEnv, type EnvSource } from "../../utils/env.ts";
import { GOOGLE_SCOPES } from "./credentials.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "./endpoints.ts";
import {
  DIRECTORY_ROLE_PRIVILEGES,
  directoryRoleName,
  executedDriveName,
  pickerKeyName,
  SETUP_APIS,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  type SetupEvent,
  type SetupStepId,
} from "./workspace-setup-names.ts";

export {
  DIRECTORY_ROLE_PRIVILEGES,
  directoryRoleName,
  executedDriveName,
  pickerKeyName,
  SETUP_APIS,
  SETUP_CALLBACK_PATH,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  type SetupEvent,
  type SetupStepId,
  type SetupStepStatus,
} from "./workspace-setup-names.ts";

// "Set everything up" for Google Workspace: one sign-in as a Workspace super
// admin, through the site's own OAuth client, grants a short-lived token;
// the server uses it to do what an administrator would otherwise click
// through in Google's consoles, then revokes it. The token is never stored.
//
// The steps, each safe to run again (what is already there is kept):
//
//   a. enable the APIs the app uses in the Cloud project (Service Usage);
//   b. create the Picker's browser key, held to the Picker API and this
//      site (API Keys API), and save it with the project number;
//   c. read the Workspace customer ID (Admin SDK) and save it;
//   d. create the "<app> directory reader" admin role (Users and Groups,
//      read) and assign it to the site's service account (Admin SDK roles
//      and role assignments; the account's unique ID from IAM);
//   e. create the "<app> Executed" Shared Drive and make the service
//      account a Content manager (Drive), when executed copies are wanted;
//   f. run the site's own checks with its service account.
//
// Google has no API for the OAuth consent screen or the OAuth client, so
// those stay a copy-paste step before this one. Each step reports done,
// skipped (already in place) or failed, with Google's status and a hint.
// Google's own error wording is not passed on: it can name accounts and
// projects.
//
// The whole run is held to SETUP_TIME_BUDGET_MS, well inside the request's
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
  appName: string;
  env?: EnvSource;
  /** What is stored now, to recognise what is already set up. */
  existing: {
    appId: string | null;
    customerId: string | null;
    directory: string | null;
    exportDriveId: string | null;
    pickerApiKey: string | null;
  };
  exportDrive: boolean;
  fetchImpl?: typeof fetch;
  projectId: string;
  projectNumber: string | null;
  /**
   * When the run has to be over (ms since the epoch), counted from when
   * the caller started; SETUP_TIME_BUDGET_MS from now when not given.
   */
  deadline?: number;
  /**
   * The checks of step f, run with the site's own service account. Each
   * check starts only with CHECK_TIME_MS left before the deadline.
   */
  runTests: (state: {
    deadline: number;
    exportDriveId: string | null;
  }) => Promise<SetupTestResult[]>;
  save: (update: IntegrationSettingsUpdate) => Promise<void>;
  serviceAccountEmail: string;
  siteUrl: string;
  /** Waits between polls; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  emit: (event: SetupEvent) => void;
};

export class GoogleSetupError extends Error {
  readonly reason: string | null;
  readonly status: number | null;

  constructor(message: string, status: number | null, reason: string | null) {
    super(message);
    this.name = "GoogleSetupError";
    this.reason = reason;
    this.status = status;
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
    details?: Array<{ reason?: string }>;
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
 * How long a run may take, counted from when the route starts it (the code
 * exchange included). The route is allowed 300 seconds: a request already
 * under way at the deadline (at most GOOGLE_REQUEST_TIMEOUT_MS) and the
 * revoke fit after it.
 */
export const SETUP_TIME_BUDGET_MS = 240_000;

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

function createClient(input: WorkspaceSetupInput, deadline: number) {
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

  return { call, finish };
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
  "Sign in with an account that is an Owner of the Cloud project, or has Service Usage Admin, API Keys Admin and Service Account Viewer on it.";
const SUPER_ADMIN_HINT = "Sign in with a Workspace super admin account.";

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

type RunState = {
  deadline: number;
  outOfTime: boolean;
  started: Set<SetupStepId>;
};

/**
 * Runs steps a to f, reporting each as it goes. Returns whether every step
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
  const { call, finish } = createClient(input, state.deadline);
  const project = input.projectNumber ?? input.projectId;
  const origin = new URL(input.siteUrl).origin;
  const encodedEmail = encodeURIComponent(input.serviceAccountEmail);
  let ok = true;
  let projectNumber = input.projectNumber;
  let customerId: string | null = null;
  let exportDriveId = input.existing.exportDriveId;

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

  // a. APIs. A 403 here means the account cannot change the project, and
  // nothing else can be done either.
  const servicesBase = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}`;
  const apisOk = await step("apis", async () => {
    let states: ServiceState[];

    try {
      const names = SETUP_APIS.map(
        (api) =>
          `names=${encodeURIComponent(`projects/${project}/services/${api}`)}`,
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
      return {
        detail: `All ${String(SETUP_APIS.length)} APIs were already on.`,
        skipped: true,
      };
    }

    try {
      await finish(
        "https://serviceusage.googleapis.com/v1",
        await call<Operation<unknown>>(
          "POST",
          `${servicesBase}/services:batchEnable`,
          {
            serviceIds: missing,
          },
        ),
      );
    } catch (error) {
      fail(error, {
        403: PROJECT_HINT,
        400: "Billing may need to be turned on for the project.",
      });
    }

    return { detail: `Turned on ${missing.join(", ")}.` };
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

  // b. The Picker's key.
  await step("picker", async () => {
    if (readEnv(env, "GOOGLE_PICKER_API_KEY")) {
      return {
        detail: "GOOGLE_PICKER_API_KEY is set where the site runs.",
        skipped: true,
      };
    }

    const keysBase = `https://apikeys.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/global/keys`;
    const displayName = pickerKeyName(input.appName);
    const restrictions = {
      apiTargets: [{ service: "picker.googleapis.com" }],
      browserKeyRestrictions: { allowedReferrers: [`${origin}/*`] },
    };

    try {
      if (!projectNumber) {
        const found = await call<{ projectNumber?: string }>(
          "GET",
          `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(input.projectId)}`,
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
    const customer = customerId ?? "my_customer";
    const rolesBase = `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(customer)}`;
    const roleName = directoryRoleName(input.appName);
    let uniqueId: string;
    let roleId: string | null = null;
    let createdRole = false;

    try {
      const account = await call<{ uniqueId?: string }>(
        "GET",
        `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodedEmail}`,
      );

      if (!account.uniqueId) {
        throw new StepFailure("IAM did not return the service account's ID.");
      }

      uniqueId = account.uniqueId;
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
          detail: `"${roleName}" was already assigned to ${input.serviceAccountEmail}.`,
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
        detail: `${createdRole ? "Created" : "Found"} "${roleName}" (Users and Groups, read) and assigned it to ${input.serviceAccountEmail}.`,
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
            permission.emailAddress?.toLowerCase() ===
            input.serviceAccountEmail.toLowerCase(),
        );
        membersToken = member ? "" : (page.nextPageToken ?? "");
      } while (membersToken);

      const canAdd =
        member?.role === "organizer" || member?.role === "fileOrganizer";

      if (!canAdd) {
        await call("POST", `${membersUrl}&sendNotificationEmail=false`, {
          emailAddress: input.serviceAccountEmail,
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
            detail: `${createdDrive ? "Created" : "Found"} "${name}", made ${input.serviceAccountEmail} a Content manager, and saved it.`,
          };
    } catch (error) {
      fail(error, {
        403: "Shared Drives may be turned off for your organization, or this account cannot create them (Admin console, Apps, Google Workspace, Drive and Docs, Sharing settings).",
      });
    }
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
          "Google can take a few minutes to apply a new role or Shared Drive member. Run the tests again from Settings in a little while.",
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
