import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "./db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "./services/secret-box.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { isMissingSchemaError } from "./settings.ts";
import { resolveDatabaseUrl, type EnvSource } from "./utils/env.ts";

// Settings for the services this install connects to, set by an
// administrator in the app instead of with environment variables: the
// Resend API key, single sign-on, the Google Workspace directory, Google
// Drive, the add-on, the people features, the seal certificate and
// timestamp server (seal-settings.ts), notifications (the Slack bot token
// among them), and where first-run onboarding stands. One row each in
// integration_settings.
//
// An environment variable that sets the same thing always wins; the code
// that uses a setting decides that, and the page shows the setting as fixed.
//
// Secret values are encrypted at rest with a key derived from the auth
// secret, as the seal key is (services/secret-box.ts), and never leave the
// server.
// If the auth secret changes, a stored secret can no longer be read and
// counts as not set, so the administrator is asked for it again.

export const INTEGRATION_SETTINGS = {
  "drive.appId": { secret: false },
  "drive.exportDriveId": { secret: false },
  "drive.exportFolderPattern": { secret: false },
  "drive.labelFields": { secret: false },
  "drive.labelId": { secret: false },
  "drive.labelsSubject": { secret: false },
  "drive.pickerApiKey": { secret: false },
  "google.addonClientId": { secret: false },
  "google.addonServiceAccount": { secret: false },
  "google.adminGroup": { secret: false },
  "google.adminSubject": { secret: false },
  "google.cloudProject": { secret: false },
  "google.customerId": { secret: false },
  "google.directory": { secret: false },
  "google.impersonateServiceAccount": { secret: false },
  // The key the automatic setup made for the app's own service account,
  // off Google Cloud. GOOGLE_SERVICE_ACCOUNT_KEY wins over it.
  "google.serviceAccountKey": { secret: true },
  // The resource name of that key, so the next key made deletes it.
  "google.serviceAccountKeyName": { secret: false },
  "google.workspaceDomains": { secret: false },
  "notifications.expiringDays": { secret: false },
  "notifications.slack.directMessages": { secret: false },
  "notifications.stuckDays": { secret: false },
  "onboarding.steps": { secret: false },
  // People features (people-policy.ts, directory-sync.ts).
  "people.directorySync": { secret: false },
  "people.googleSigning": { secret: false },
  "people.managerPolicy": { secret: false },
  "people.managerPolicyTeams": { secret: false },
  "resend.apiKey": { secret: true },
  "seal.certificate": { secret: false },
  "seal.p12": { secret: true },
  "seal.p12Password": { secret: true },
  "seal.timestampUrl": { secret: false },
  "slack.botToken": { secret: true },
  "sso.clientId": { secret: false },
  "sso.clientSecret": { secret: true },
  "sso.issuer": { secret: false },
  "sso.name": { secret: false },
  "sso.passwordAllowedEmails": { secret: false },
  "sso.passwordSignIn": { secret: false },
} as const satisfies Record<string, { secret: boolean }>;

export type IntegrationSettingKey = keyof typeof INTEGRATION_SETTINGS;

/** What is stored, secrets decrypted. A key that is not there is not set. */
export type IntegrationSettings = Partial<
  Record<IntegrationSettingKey, string>
>;

/** A change: a string sets the value, null removes it. */
export type IntegrationSettingsUpdate = Partial<
  Record<IntegrationSettingKey, string | null>
>;

export type IntegrationSettingsActor = {
  email: string;
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type IntegrationSettingRow = {
  key: string;
  secret: boolean;
  value: string;
};

// Other instances pick up a change within this time, like app settings.
const CACHE_MS = 30_000;
const ENCRYPTION_CONTEXT = "signudoc/integration-settings/v1";
const INTEGRATION_SETTINGS_LOCK_ID = 746108340;

type IntegrationSettingsCache = {
  expiresAt: number;
  value: IntegrationSettings;
} | null;

declare global {
  var __signudocIntegrationSettings: IntegrationSettingsCache | undefined;
  var __signudocIntegrationGeneration: number | undefined;
}

function isKnownKey(key: string): key is IntegrationSettingKey {
  return Object.hasOwn(INTEGRATION_SETTINGS, key);
}

function keyFor(name: IntegrationSettingKey, env: EnvSource): Buffer {
  return secretKeyFor(`${ENCRYPTION_CONTEXT}/${name}`, env);
}

const warned = new Set<string>();

/** Reads every stored setting, uncached. Empty before the migration has run. */
export async function readIntegrationSettings(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<IntegrationSettings> {
  let rows: IntegrationSettingRow[];

  try {
    rows = await queryMany<IntegrationSettingRow>(
      database,
      `SELECT key, value, secret FROM public.integration_settings`,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {};
    }

    throw error;
  }

  const settings: IntegrationSettings = {};

  for (const row of rows) {
    if (!isKnownKey(row.key)) {
      continue;
    }

    if (!row.secret) {
      settings[row.key] = row.value;
      continue;
    }

    const value = decryptPrivateKey(row.value, keyFor(row.key, env));

    if (value === null) {
      if (!warned.has(row.key)) {
        warned.add(row.key);
        console.warn(
          `[settings] The stored ${row.key} cannot be read with the current auth secret. Enter it again in Settings.`,
        );
      }

      continue;
    }

    settings[row.key] = value;
  }

  return settings;
}

/** The stored settings, cached for a short time. */
export async function getIntegrationSettings(
  env: EnvSource = process.env,
): Promise<IntegrationSettings> {
  const cached = globalThis.__signudocIntegrationSettings;

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const generation = globalThis.__signudocIntegrationGeneration ?? 0;
  const value = await readIntegrationSettings(getDb(), env);

  // A save or a clear happened while this was reading, so what was read may
  // be from before it.
  if ((globalThis.__signudocIntegrationGeneration ?? 0) === generation) {
    globalThis.__signudocIntegrationSettings = {
      expiresAt: Date.now() + CACHE_MS,
      value,
    };
  }

  return value;
}

/**
 * The settings last read in this process, or null when none have been read
 * yet. For code that cannot wait for the database and only needs a hint.
 */
export function peekIntegrationSettings(): IntegrationSettings | null {
  return globalThis.__signudocIntegrationSettings?.value ?? null;
}

/**
 * Reads the settings once when the server starts (instrumentation.ts), so
 * code that cannot wait for the database (createEmailService) knows from
 * the first request whether a Resend key was saved. Gives up quietly, and
 * after a few seconds at most: the server must start whatever the database
 * is doing.
 */
export async function primeIntegrationSettings(
  env: EnvSource = process.env,
): Promise<void> {
  if (!resolveDatabaseUrl(env)) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      getIntegrationSettings(env),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.warn(
        "[settings] Could not read the integration settings at startup:",
        error instanceof Error ? error.message : error,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export function invalidateIntegrationSettingsCache() {
  globalThis.__signudocIntegrationGeneration =
    (globalThis.__signudocIntegrationGeneration ?? 0) + 1;
  globalThis.__signudocIntegrationSettings = undefined;
}

/** How a change shows in the audit trail. A secret's value never does. */
function describeChange(
  key: IntegrationSettingKey,
  from: string | undefined,
  to: string | null,
): { from: unknown; to: unknown } {
  if (INTEGRATION_SETTINGS[key].secret) {
    return {
      from: from === undefined ? null : "set",
      to: to === null ? null : from === undefined ? "set" : "replaced",
    };
  }

  return { from: from ?? null, to };
}

/**
 * Writes the given settings and records what changed in the install's audit
 * trail, in one transaction. Settings that are not named are left alone.
 * Returns the stored settings after the change.
 *
 * The update can be a function of the settings as they are stored once
 * the rows are locked, for a change made from what is there now (merging
 * one entry into a JSON value, say). It is also given the transaction, so
 * work that must stand or fall with the save can run inside it.
 */
export async function saveIntegrationSettings(
  update:
    | IntegrationSettingsUpdate
    | ((
        before: IntegrationSettings,
        tx: DbExecutor,
      ) => IntegrationSettingsUpdate | Promise<IntegrationSettingsUpdate>),
  actor: IntegrationSettingsActor | null,
  {
    area,
    database = getDb(),
    env = process.env,
  }: { area: string; database?: DbPool; env?: EnvSource },
): Promise<IntegrationSettings> {
  const saved = await withTransaction(async (tx) => {
    // Locks the rows that are there; two saves of the same setting take
    // turns, so the audit trail's "from" is the value really replaced.
    const before = await readIntegrationSettingsForUpdate(tx, env);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const now = Math.floor(Date.now() / 1000);

    const changesToMake =
      typeof update === "function" ? await update(before, tx) : update;

    for (const [rawKey, rawValue] of Object.entries(changesToMake)) {
      if (!isKnownKey(rawKey) || rawValue === undefined) {
        continue;
      }

      const key = rawKey;
      // A secret is kept as it was given: spaces can be part of a password.
      const value =
        rawValue === null
          ? null
          : INTEGRATION_SETTINGS[key].secret
            ? rawValue
            : rawValue.trim();
      const next = value === "" ? null : value;
      const previous = before[key];

      if (next !== null && next === previous) {
        continue;
      }

      if (next === null) {
        // Always run, since a stored secret that can no longer be read is
        // missing from `before` and still has to go.
        const removed = await tx.query(
          `DELETE FROM public.integration_settings WHERE key = $1`,
          [key],
        );

        if (!removed.rowCount) {
          continue;
        }

        changes[key] = INTEGRATION_SETTINGS[key].secret
          ? { from: "set", to: null }
          : describeChange(key, previous, null);
        continue;
      }

      const secret = INTEGRATION_SETTINGS[key].secret;

      await tx.query(
        `
          INSERT INTO public.integration_settings (key, value, secret, updated_at, updated_by)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (key) DO UPDATE SET
            value = excluded.value,
            secret = excluded.secret,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `,
        [
          key,
          secret ? encryptPrivateKey(next, keyFor(key, env)) : next,
          secret,
          now,
          actor?.id ?? null,
        ],
      );
      changes[key] = describeChange(key, previous, next);
    }

    if (Object.keys(changes).length > 0) {
      await recordSystemAuditEvent(
        {
          actorEmail: actor?.email ?? null,
          actorUserId: actor?.id ?? null,
          event: "settings_changed",
          ipAddress: actor?.ipAddress ?? null,
          metadata: { area, changes },
          userAgent: actor?.userAgent ?? null,
        },
        tx,
      );
    }

    return readIntegrationSettings(tx, env);
  }, database);

  // This instance sees the change at once; others within the cache time.
  // The number moves on so a read that began before the commit cannot
  // overwrite this with the old values.
  globalThis.__signudocIntegrationGeneration =
    (globalThis.__signudocIntegrationGeneration ?? 0) + 1;
  globalThis.__signudocIntegrationSettings = {
    expiresAt: Date.now() + CACHE_MS,
    value: saved,
  };

  return saved;
}

async function readIntegrationSettingsForUpdate(
  database: DbExecutor,
  env: EnvSource,
): Promise<IntegrationSettings> {
  // One lock for the whole table: settings are few and rarely changed.
  await database.query("SELECT pg_advisory_xact_lock($1)", [
    INTEGRATION_SETTINGS_LOCK_ID,
  ]);

  return readIntegrationSettings(database, env);
}
