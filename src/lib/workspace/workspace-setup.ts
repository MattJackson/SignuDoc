import { randomBytes } from "node:crypto";

import { type DbPool, getDb } from "../db/connection.ts";
import { logRouteError } from "../security/logging.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import { getBranding, readStoredSettings } from "../settings.ts";
import { resolveAuthUrl, type EnvSource } from "../utils/env.ts";
import { WorkspaceSettingsInputError } from "./admin-view.ts";
import { FILES_CALLBACK_PATH } from "./files.ts";
import { resolveOrganizationDomains } from "./offboarding.ts";
import { findWorkspaceProvider, WORKSPACE_PROVIDERS } from "./registry.ts";
import {
  readWorkspaceSettings,
  resolveWorkspaceSetting,
  saveWorkspaceSettings,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
  type WorkspaceSettingsActor,
  type WorkspaceSettingsUpdate,
} from "./settings.ts";
import type {
  WorkspaceAutomaticSetup,
  WorkspaceAutomaticSetupInfo,
  WorkspaceCheck,
  WorkspaceCheckTarget,
  WorkspaceProviderPackage,
  WorkspaceSetup,
  WorkspaceSetupEvent,
  WorkspaceSetupGuide,
  WorkspaceSetupSite,
} from "./types.ts";

// Setting a workspace provider up from Settings, the app's side of it, with
// no provider in it: the setup page's view (the provider's guide, step by
// step, and its automatic setup), saving the guide's fields and running its
// checks, and the automatic run itself. The provider does the rest
// (WorkspaceSetup in types.ts), so another provider's guide and automatic
// setup come through here with no change.
//
// The automatic run: the administrator signs in once with the provider,
// which sends them back to the setup page with a code; the page posts it
// to /api/admin/workspace/setup/run, which streams each step. The state and
// the provider's PKCE verifier wait in a short-lived encrypted cookie. A
// choice the run asks for (the Cloud project, for Google) comes back
// through /api/admin/workspace/setup/choose and the database, since it can
// reach another instance. One run at a time, held to a time budget well
// inside the route's 300 seconds, so the provider always gets to revoke
// the sign-in's token.

/** The setup page, and where a provider sends the administrator back. */
export const WORKSPACE_SETUP_PATH = "/settings/workspace-setup";
export const SETUP_COOKIE = "signudoc_workspace_setup";
/** The cookie is only sent to the setup routes. */
export const SETUP_COOKIE_PATH = "/api/admin/workspace/setup";
export const SETUP_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** Better Auth's single sign-on callback (auth/sso.ts). */
const SIGN_IN_CALLBACK_PATH = "/api/auth/callback/sso";

/**
 * How long a run may take, counted from when the route starts it: the code
 * exchange, the wait for a choice and every step. A request already under
 * way at the deadline (15 seconds at most) and the revoke fit well inside
 * the route's 300.
 */
export const SETUP_TIME_BUDGET_MS = 190_000;

/** How long a run waits for the administrator to choose. */
export const CHOICE_WAIT_MS = 60_000;
const CHOICE_POLL_MS = 1000;
const WAITING_EVENT_MS = 15_000;
// Choices nobody collected are removed after this long.
const CHOICE_TTL_SECONDS = 60 * 60;

// One automatic setup at a time, across instances: two at once would both
// find nothing yet and both make the role and the Shared Drive.
const WORKSPACE_SETUP_LOCK_ID = 746108360;

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") || null;
  } catch {
    return null;
  }
}

/** Where a provider sends the administrator back after signing in. */
export function setupRedirectUri(env: EnvSource = process.env): string | null {
  const url = siteUrl(env);

  return url ? `${url}${WORKSPACE_SETUP_PATH}` : null;
}

/** What a provider's setup is told about this site. */
export async function describeSetupSite(
  env: EnvSource = process.env,
): Promise<WorkspaceSetupSite> {
  const url = siteUrl(env);
  const branding = await getBranding(env);

  return {
    brandColor: branding.brandColor,
    callbacks: {
      files: url ? `${url}${FILES_CALLBACK_PATH}` : null,
      setup: url ? `${url}${WORKSPACE_SETUP_PATH}` : null,
      signIn: url ? `${url}${SIGN_IN_CALLBACK_PATH}` : null,
    },
    name:
      branding.organizationName?.trim() ||
      branding.productName.trim() ||
      "SignuDoc",
    url,
  };
}

/**
 * The provider to set up: the one asked for, else the default provider,
 * else the first installed. Null when none is installed.
 */
export function chooseSetupProvider(
  requested: string | null | undefined,
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
  providers: readonly WorkspaceProviderPackage[] = WORKSPACE_PROVIDERS,
): WorkspaceProviderPackage | null {
  return (
    findWorkspaceProvider(requested, providers) ??
    findWorkspaceProvider(
      resolveWorkspaceSetting("workspace.provider", stored, env).value,
      providers,
    ) ??
    providers[0] ??
    null
  );
}

type ProviderRef = { id: string; label: string };

export type WorkspaceSetupView = {
  automatic: WorkspaceAutomaticSetupInfo | null;
  guide: WorkspaceSetupGuide | null;
  provider: ProviderRef;
  /** Every installed provider, to set up another. */
  providers: ProviderRef[];
};

async function setupFor(
  requested: string | null | undefined,
  env: EnvSource,
): Promise<{
  provider: WorkspaceProviderPackage;
  settings: WorkspaceSettings;
  setup: WorkspaceSetup;
} | null> {
  // Read fresh, not from the short-lived cache, so the page never shows a
  // value that was just replaced.
  const settings = await readWorkspaceSettings();
  const provider = chooseSetupProvider(requested, settings, env);

  return provider
    ? { provider, settings, setup: provider.setup({ env, settings }) }
    : null;
}

/** What the setup page shows, or null when no provider is installed. */
export async function getWorkspaceSetupView(
  requested: string | null | undefined,
  env: EnvSource = process.env,
): Promise<WorkspaceSetupView | null> {
  const found = await setupFor(requested, env);

  if (!found) {
    return null;
  }

  const site = await describeSetupSite(env);
  const { provider, setup } = found;

  return {
    automatic: setup.automatic?.describe(site) ?? null,
    guide: (await setup.guide?.(site)) ?? null,
    provider: { id: provider.id, label: provider.label },
    providers: WORKSPACE_PROVIDERS.map((item) => ({
      id: item.id,
      label: item.label,
    })),
  };
}

const CHECK_TARGETS: readonly WorkspaceCheckTarget[] = [
  "identity",
  "directory",
  "adminGroup",
  "files",
  "addIn",
];

export function isSetupCheckTarget(
  value: unknown,
): value is WorkspaceCheckTarget {
  return (CHECK_TARGETS as readonly unknown[]).includes(value);
}

/** One step's checks, as the administrator. */
export async function checkSetupStep(
  requested: string | null | undefined,
  target: WorkspaceCheckTarget,
  email: string,
  env: EnvSource = process.env,
): Promise<WorkspaceCheck[]> {
  const found = await setupFor(requested, env);

  return found ? found.setup.check(target, { email }) : [];
}

/**
 * The default provider to save with a change, when none is chosen yet: a
 * provider that has been set up is the one in use.
 */
function defaultProviderUpdate(
  providerId: string,
  stored: WorkspaceSettings,
  env: EnvSource,
): WorkspaceSettingsUpdate {
  return resolveWorkspaceSetting("workspace.provider", stored, env).value
    ? {}
    : { "workspace.provider": providerId };
}

/**
 * Saves values pasted into the guide's fields: `{ settings: { key: value } }`.
 * Only keys the guide offers are taken, each checked by the provider; one
 * an environment variable fixes is left out. Returns the keys that changed.
 */
export async function saveSetupGuideValues(
  requested: string | null | undefined,
  raw: unknown,
  actor: WorkspaceSettingsActor,
  env: EnvSource = process.env,
): Promise<WorkspaceSettingKey[]> {
  const found = await setupFor(requested, env);
  const guide = found
    ? await found.setup.guide?.(await describeSetupSite(env))
    : null;

  if (!found || !guide) {
    throw new WorkspaceSettingsInputError({}, "Nothing to save.");
  }

  const input =
    raw && typeof raw === "object" && "settings" in raw
      ? (raw as { settings: unknown }).settings
      : null;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceSettingsInputError({}, "Nothing to save.");
  }

  const fields = new Map(
    guide.steps.flatMap((step) =>
      step.fields.map((field) => [field.setting as string, field] as const),
    ),
  );
  const update: WorkspaceSettingsUpdate = {};
  const errors: Partial<Record<WorkspaceSettingKey, string>> = {};

  for (const [key, value] of Object.entries(input)) {
    const field = fields.get(key);

    if (!field) {
      throw new WorkspaceSettingsInputError({}, `Unknown setting: ${key}.`);
    }

    if (field.source === "env") {
      continue;
    }

    if (value !== null && typeof value !== "string") {
      errors[field.setting] = "Enter text.";
      continue;
    }

    const trimmed = value?.trim() ?? "";

    if (!trimmed) {
      update[field.setting] = null;
      continue;
    }

    if (trimmed.length > 320) {
      errors[field.setting] = "This is too long.";
      continue;
    }

    const checked = found.setup.normalizeGuideValue?.(
      field.setting,
      trimmed,
    ) ?? {
      error: "This setting is saved in its own section.",
    };

    if ("error" in checked) {
      errors[field.setting] = checked.error;
    } else {
      update[field.setting] = checked.value;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new WorkspaceSettingsInputError(errors);
  }

  if (Object.keys(update).length === 0) {
    return [];
  }

  return saveWorkspaceSettings(
    {
      ...update,
      ...defaultProviderUpdate(found.provider.id, found.settings, env),
    },
    actor,
  );
}

/** The automatic setup of a provider, or null when it has none. */
export async function getAutomaticSetup(
  requested: string | null | undefined,
  env: EnvSource = process.env,
): Promise<{
  automatic: WorkspaceAutomaticSetup;
  provider: WorkspaceProviderPackage;
} | null> {
  const found = await setupFor(requested, env);

  return found?.setup.automatic
    ? { automatic: found.setup.automatic, provider: found.provider }
    : null;
}

// The sign-in's state, the provider's secret and the toggles, kept in a
// short-lived, encrypted, HttpOnly cookie between leaving for the provider
// and coming back.

export type SetupState = {
  createdAt: number;
  provider: string;
  /** The provider's secret for this sign-in (a PKCE verifier). */
  secret: string;
  state: string;
  toggles: Record<string, boolean>;
  userId: string;
};

const STATE_CONTEXT = "signudoc/workspace-setup-state/v1";

export function newSetupStateValue(): string {
  return randomBytes(24).toString("base64url");
}

export function sealSetupState(
  value: SetupState,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(
    JSON.stringify(value),
    secretKeyFor(STATE_CONTEXT, env),
  );
}

/** The cookie's contents, or null when it is missing, forged or too old. */
export function openSetupState(
  sealed: string | null | undefined,
  env: EnvSource = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): SetupState | null {
  if (!sealed) {
    return null;
  }

  const json = decryptPrivateKey(sealed, secretKeyFor(STATE_CONTEXT, env));

  if (!json) {
    return null;
  }

  try {
    const value = JSON.parse(json) as Partial<SetupState>;

    if (
      typeof value.state !== "string" ||
      typeof value.secret !== "string" ||
      typeof value.provider !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.createdAt !== "number" ||
      !value.toggles ||
      typeof value.toggles !== "object" ||
      Object.values(value.toggles).some((item) => typeof item !== "boolean") ||
      nowSeconds - value.createdAt > SETUP_COOKIE_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return value as SetupState;
  } catch {
    return null;
  }
}

/** The toggles from the start link: each "1" or "0", known ids only. */
export function readSetupToggles(
  info: WorkspaceAutomaticSetupInfo,
  params: URLSearchParams,
): Record<string, boolean> {
  return Object.fromEntries(
    info.toggles.map((toggle) => {
      const value = params.get(toggle.id);

      return [toggle.id, value === null ? toggle.defaultOn : value === "1"];
    }),
  );
}

/**
 * Takes the setup's lock, held by a transaction on a connection of its own
 * that writes nothing, as the daily cleanup's is (retention-job.ts). Gives
 * back how to let it go, or null when another run holds it.
 */
async function takeSetupLock(
  pool: DbPool,
): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const release = async () => {
    await client.query("rollback").catch(() => undefined);
    client.release();
  };

  try {
    await client.query("begin");

    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [WORKSPACE_SETUP_LOCK_ID],
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

/** Records the administrator's choice for a run. False when it is not new. */
export async function submitSetupChoice(
  input: { choice: string; runId: string; userId: string },
  pool: DbPool = getDb(),
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO public.workspace_setup_choices (run_id, user_id, choice, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id, user_id) DO NOTHING`,
    [input.runId, input.userId, input.choice, Math.floor(Date.now() / 1000)],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Waits for the choice for this run from this person, and takes it. Null
 * when none came in time. An answer from anyone else is never taken.
 */
async function waitForSetupChoice(input: {
  emit: (event: WorkspaceSetupEvent) => void;
  pool: DbPool;
  runId: string;
  sleep: (ms: number) => Promise<void>;
  userId: string;
  waitMs: number;
}): Promise<string | null> {
  const until = Date.now() + input.waitMs;
  let lastSent = Date.now();

  await input.pool.query(
    `DELETE FROM public.workspace_setup_choices WHERE created_at < $1`,
    [Math.floor(Date.now() / 1000) - CHOICE_TTL_SECONDS],
  );

  while (Date.now() < until) {
    const taken = await input.pool.query<{ choice: string }>(
      `DELETE FROM public.workspace_setup_choices
       WHERE run_id = $1 AND user_id = $2
       RETURNING choice`,
      [input.runId, input.userId],
    );
    const row = taken.rows[0];

    if (row) {
      return row.choice;
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

/** The organization's email domains, for a provider to hold sign-ins to. */
async function organizationDomains(
  stored: WorkspaceSettings,
  env: EnvSource,
  pool: DbPool,
): Promise<string[]> {
  if (resolveWorkspaceSetting("directory.domains", stored, env).value) {
    return resolveOrganizationDomains(stored, env);
  }

  const settings = await readStoredSettings(pool).catch(() => null);

  return resolveOrganizationDomains(
    stored,
    env,
    settings?.signupMode === "domains" ? settings.allowedEmailDomains : [],
  );
}

export type RunWorkspaceSetupInput = {
  actor: WorkspaceSettingsActor;
  automatic: WorkspaceAutomaticSetup;
  /** How long to wait for a choice; CHOICE_WAIT_MS by default. */
  choiceWaitMs?: number;
  code: string;
  emit: (event: WorkspaceSetupEvent) => void;
  env?: EnvSource;
  pool?: DbPool;
  providerId: string;
  /** What the provider's start() returned as secret. */
  secret: string;
  /** Waits between polls; tests make it short. */
  sleep?: (ms: number) => Promise<void>;
  toggles: Readonly<Record<string, boolean>>;
};

/**
 * Runs a provider's automatic setup with the code it sent back, one run at
 * a time and within SETUP_TIME_BUDGET_MS, and always ends with a
 * `finished` event. Each event is passed on as it happens; one that cannot
 * be sent (the page went away) does not stop the run.
 */
export async function runWorkspaceSetup(
  input: RunWorkspaceSetupInput,
): Promise<void> {
  // The run's time is counted from here, so the code exchange and the wait
  // for the administrator's choice are inside it too.
  const deadline = Date.now() + SETUP_TIME_BUDGET_MS;
  const env = input.env ?? process.env;
  const pool = input.pool ?? getDb();
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emit = (event: WorkspaceSetupEvent) => {
    try {
      input.emit(event);
    } catch {
      // Nobody is reading any more.
    }
  };
  const site = await describeSetupSite(env);
  const redirectUri = site.callbacks.setup;
  const problem = input.automatic.describe(site).problem;

  if (problem || !redirectUri) {
    // The code is never used, so no token was made.
    emit({
      message: problem ?? "The setup cannot run here.",
      type: "refused",
    });
    emit({ ok: false, revoked: true, type: "finished" });
    return;
  }

  const release = await takeSetupLock(pool);

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
    const settings = await readWorkspaceSettings(pool);
    let defaultProvider = defaultProviderUpdate(
      input.providerId,
      settings,
      env,
    );
    const result = await input.automatic.run({
      choose: async (offer) => {
        const runId = randomBytes(24).toString("base64url");
        // The wait comes out of the run's own time, so the whole request
        // stays inside the route's limit however long the choice takes.
        const waitMs = Math.max(
          0,
          Math.min(input.choiceWaitMs ?? CHOICE_WAIT_MS, deadline - Date.now()),
        );

        emit({
          ...offer,
          runId,
          type: "choose",
          waitSeconds: Math.round(waitMs / 1000),
        });

        return waitForSetupChoice({
          emit,
          pool,
          runId,
          sleep,
          userId: input.actor.id,
          waitMs,
        });
      },
      code: input.code,
      deadline,
      emit,
      organizationDomains: await organizationDomains(settings, env, pool),
      redirectUri,
      save: async (update) => {
        await saveWorkspaceSettings(
          { ...update, ...defaultProvider },
          input.actor,
          pool,
        );
        defaultProvider = {};
      },
      secret: input.secret,
      settings,
      site,
      toggles: input.toggles,
    });

    emit({ ok: result.ok, revoked: result.revoked, type: "finished" });
  } catch (error) {
    // The page gets our own words; the log gets the error.
    logRouteError(error, {
      category: "workspace_setup_failure",
      ipAddress: input.actor.ipAddress ?? null,
      message: "Unexpected failure in the automatic workspace setup.",
      userId: input.actor.id,
    });
    emit({ message: "The setup stopped unexpectedly.", type: "refused" });
    emit({ ok: false, revoked: false, type: "finished" });
  } finally {
    await release();
  }
}
