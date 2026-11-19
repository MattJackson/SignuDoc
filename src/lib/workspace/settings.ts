import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { isMissingSchemaError } from "../settings.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";

// The workspace settings an administrator chooses in Settings: which
// provider serves each capability, and which parts are on and how. One row
// per setting in workspace_settings.
//
// Nothing secret is kept here. Keys, client secrets and tokens the site
// itself uses come from environment variables only.
//
// Every setting also has an environment variable. One that is set wins,
// and the page shows the setting as fixed, as with the other settings
// (settings.ts).
//
// Names are provider-neutral ("directory.enabled") unless a value only
// means something to one provider, which then carries its id
// ("google.customerId").

export const WORKSPACE_SETTINGS = {
  // The provider for every capability not chosen on its own (registry.ts).
  "workspace.provider": { env: "WORKSPACE_PROVIDER" },
  "addIn.provider": { env: "WORKSPACE_ADDIN_PROVIDER" },
  "directory.provider": { env: "WORKSPACE_DIRECTORY_PROVIDER" },
  "files.provider": { env: "WORKSPACE_FILES_PROVIDER" },
  // "on" turns the directory on: suggestions and the administrator group.
  "directory.enabled": { env: "WORKSPACE_DIRECTORY" },
  // A group's address. Its members are administrators (admin-group.ts).
  "directory.adminGroup": { env: "WORKSPACE_ADMIN_GROUP" },
  // The Google Workspace customer the directory is read for.
  "google.customerId": { env: "GOOGLE_WORKSPACE_CUSTOMER_ID" },
  // A Workspace administrator to read the directory as, with domain-wide
  // delegation. Empty: the service account reads it with its own role.
  "google.adminSubject": { env: "GOOGLE_WORKSPACE_ADMIN_SUBJECT" },
  // "on" turns offboarding on: people the directory says have left are
  // blocked and their open work handed over (offboarding.ts). Needs the
  // directory to be on.
  "directory.offboarding": { env: "WORKSPACE_OFFBOARDING" },
  // The organization's email domains, comma-separated: only accounts in
  // them are asked about. Empty: the sign-up rule's domains.
  "directory.domains": { env: "WORKSPACE_DIRECTORY_DOMAINS" },
} as const satisfies Record<string, { env: string }>;

export type WorkspaceSettingKey = keyof typeof WORKSPACE_SETTINGS;

/** What is stored. A key that is not there is not set. */
export type WorkspaceSettings = Partial<Record<WorkspaceSettingKey, string>>;

/** A change: a string sets the value, null removes it. */
export type WorkspaceSettingsUpdate = Partial<
  Record<WorkspaceSettingKey, string | null>
>;

export type ResolvedWorkspaceSetting = {
  /** "env" when the environment fixes it and the page cannot change it. */
  source: "env" | "none" | "settings";
  value: string | null;
};

export type WorkspaceSettingsActor = {
  email: string;
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

// Other instances pick up a change within this time, like app settings.
const CACHE_MS = 30_000;
const MAX_VALUE_LENGTH = 2000;

type Cache = { expiresAt: number; value: WorkspaceSettings } | null;

declare global {
  var __signudocWorkspaceSettings: Cache | undefined;
}

export function isWorkspaceSettingKey(key: string): key is WorkspaceSettingKey {
  return Object.hasOwn(WORKSPACE_SETTINGS, key);
}

/** Reads every stored setting, uncached. Empty before the migration. */
export async function readWorkspaceSettings(
  database: DbExecutor = getDb(),
): Promise<WorkspaceSettings> {
  let rows: Array<{ key: string; value: string }>;

  try {
    rows = await queryMany<{ key: string; value: string }>(
      database,
      `SELECT key, value FROM public.workspace_settings`,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {};
    }

    throw error;
  }

  const settings: WorkspaceSettings = {};

  for (const row of rows) {
    // A row a newer version wrote, or an older one left, is not read.
    if (isWorkspaceSettingKey(row.key)) {
      settings[row.key] = row.value;
    }
  }

  return settings;
}

/** The stored settings, cached for a short while. */
export async function getWorkspaceSettings(
  database: DbExecutor = getDb(),
): Promise<WorkspaceSettings> {
  const cached = globalThis.__signudocWorkspaceSettings;

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await readWorkspaceSettings(database);

  globalThis.__signudocWorkspaceSettings = {
    expiresAt: Date.now() + CACHE_MS,
    value,
  };

  return value;
}

export function invalidateWorkspaceSettingsCache() {
  globalThis.__signudocWorkspaceSettings = null;
}

/** One setting: the environment's value if set, else the stored one. */
export function resolveWorkspaceSetting(
  key: WorkspaceSettingKey,
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): ResolvedWorkspaceSetting {
  const fromEnv = readEnv(env, WORKSPACE_SETTINGS[key].env);

  if (fromEnv) {
    return { source: "env", value: fromEnv };
  }

  const value = stored?.[key]?.trim();

  return value
    ? { source: "settings", value }
    : { source: "none", value: null };
}

export class WorkspaceSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSettingsError";
  }
}

/**
 * Saves a change and records it in the install's audit trail, in one
 * transaction. Values are not secret, so the trail shows them. Returns the
 * keys that changed.
 */
export async function saveWorkspaceSettings(
  update: WorkspaceSettingsUpdate,
  actor: WorkspaceSettingsActor,
  pool: DbPool = getDb(),
): Promise<WorkspaceSettingKey[]> {
  for (const [key, value] of Object.entries(update)) {
    if (!isWorkspaceSettingKey(key)) {
      throw new WorkspaceSettingsError(`Unknown setting: ${key}.`);
    }

    if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
      throw new WorkspaceSettingsError(`${key} is too long.`);
    }
  }

  const changed = await withTransaction(async (tx) => {
    // One writer at a time, so two saves cannot both read the old values
    // and record the same change twice.
    await tx.query(`LOCK TABLE public.workspace_settings IN EXCLUSIVE MODE`);

    const before = await readWorkspaceSettings(tx);
    const now = Date.now();
    const changes: Record<string, { from: string | null; to: string | null }> =
      {};

    for (const [key, raw] of Object.entries(update) as Array<
      [WorkspaceSettingKey, string | null | undefined]
    >) {
      if (raw === undefined) {
        continue;
      }

      const value = raw === null ? null : raw.trim() || null;
      const previous = before[key] ?? null;

      if (value === previous) {
        continue;
      }

      if (value === null) {
        await tx.query(`DELETE FROM public.workspace_settings WHERE key = $1`, [
          key,
        ]);
      } else {
        await tx.query(
          `
            INSERT INTO public.workspace_settings (key, value, updated_at, updated_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by
          `,
          [key, value, now, actor.id],
        );
      }

      changes[key] = { from: previous, to: value };
    }

    if (Object.keys(changes).length > 0) {
      await recordSystemAuditEvent(
        {
          actorEmail: actor.email,
          actorUserId: actor.id,
          event: "settings_changed",
          ipAddress: actor.ipAddress ?? null,
          metadata: { workspace: changes },
          userAgent: actor.userAgent ?? null,
        },
        tx,
      );
    }

    return Object.keys(changes) as WorkspaceSettingKey[];
  }, pool);

  invalidateWorkspaceSettingsCache();

  return changed;
}
