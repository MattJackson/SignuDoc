import { randomUUID } from "node:crypto";

import {
  type BackupStore,
  type BackupSummary,
  type BackupTarget,
  DEFAULT_KEEP_DAYS,
  isBackupStoreTheAppStore,
  parseKeepDays,
  readBackupTargetFromEnv,
  readKeepDaysFromEnv,
  runBackup,
} from "./backup.ts";
import {
  createAppFilesStore,
  createBackupTargetStore,
  findServiceAccountEmail,
} from "./backup-stores.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "./services/seal-identity.ts";
import { ServiceConfigurationError } from "./services/service-config.ts";
import { resolveStorageDriver } from "./services/storage/driver.ts";
import { GcsRequestError, normalizeGcsPrefix } from "./services/storage/gcs.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { type EnvSource } from "./utils/env.ts";

// Where the daily backup (backup.ts) goes, chosen by an administrator in
// Settings and kept in the backup_settings row, with a record of each run
// in backup_runs. The environment still wins: BACKUP_GCS_BUCKET or
// BACKUP_BLOB_READ_WRITE_TOKEN fix the destination, and BACKUP_KEEP_DAYS
// the number of days, and Settings shows them as set by the deployment.
//
// A Blob store's token is kept encrypted with a key derived from the auth
// secret, as the seal key is. A Cloud Storage bucket needs no secret on
// Google Cloud: the app writes to it as the service account it runs as.

const TOKEN_KEY_CONTEXT = "signudoc-backup-blob-token";
/** A run still marked running after this long was stopped part way. */
const STALE_RUN_SECONDS = 15 * 60;
/** How many runs are kept for the history in Settings. */
const KEPT_RUNS = 50;
/** A backup that has not succeeded for this long is reported as failing. */
const OVERDUE_SECONDS = 2 * 24 * 60 * 60;
/** Serializes starting a run, so two cannot start together. */
const BACKUP_RUN_LOCK_ID = 746108326;
export const BACKUP_BUCKET_ROLE = "roles/storage.objectAdmin";

export type BackupDestinationKind = "blob" | "gcs" | "none";

export type StoredBackupConfig = {
  blobTokenEncrypted: string | null;
  destination: BackupDestinationKind;
  enabled: boolean;
  gcsBucket: string | null;
  gcsPrefix: string;
  keepDays: number;
  updatedAt: number;
  updatedBy: string | null;
};

export type EffectiveBackupConfig = {
  enabled: boolean;
  keepDays: number;
  locked: { destination: boolean; keepDays: boolean };
  target: BackupTarget | null;
  /** A saved Blob token that no longer decrypts: the auth secret changed. */
  tokenUnreadable: boolean;
};

export class BackupConfigError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BackupConfigError";
    this.statusCode = statusCode;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

/** A Blob token as kept in the database. */
export function encryptBackupToken(
  token: string,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(token, secretKeyFor(TOKEN_KEY_CONTEXT, env));
}

/** The token back, or null when it no longer decrypts. */
export function decryptBackupToken(
  value: string,
  env: EnvSource = process.env,
): string | null {
  return decryptPrivateKey(value, secretKeyFor(TOKEN_KEY_CONTEXT, env));
}

export async function readStoredBackupConfig(
  database: DbExecutor = getDb(),
): Promise<StoredBackupConfig | null> {
  return queryOne<StoredBackupConfig>(
    database,
    `
      SELECT
        destination,
        gcs_bucket AS "gcsBucket",
        gcs_prefix AS "gcsPrefix",
        blob_token_encrypted AS "blobTokenEncrypted",
        keep_days AS "keepDays",
        enabled,
        updated_at AS "updatedAt",
        updated_by AS "updatedBy"
      FROM backup_settings
      WHERE id
    `,
  );
}

/** What the backup does: the environment's settings over the stored ones. */
export function resolveBackupConfig(
  stored: StoredBackupConfig | null,
  env: EnvSource = process.env,
): EffectiveBackupConfig {
  const envTarget = readBackupTargetFromEnv(env);
  const envKeepDays = readKeepDaysFromEnv(env);
  let target: BackupTarget | null = envTarget;
  let tokenUnreadable = false;

  if (!target && stored?.destination === "gcs" && stored.gcsBucket) {
    target = {
      bucket: stored.gcsBucket,
      kind: "gcs",
      prefix: stored.gcsPrefix,
    };
  }

  if (!target && stored?.destination === "blob" && stored.blobTokenEncrypted) {
    const token = decryptBackupToken(stored.blobTokenEncrypted, env);

    if (token) {
      target = { kind: "blob", token };
    } else {
      tokenUnreadable = true;
    }
  }

  return {
    // A destination set by the deployment is meant to run.
    enabled: envTarget ? true : (stored?.enabled ?? true),
    keepDays: envKeepDays ?? stored?.keepDays ?? DEFAULT_KEEP_DAYS,
    locked: { destination: Boolean(envTarget), keepDays: envKeepDays !== null },
    target,
    tokenUnreadable,
  };
}

export async function getBackupConfig(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<EffectiveBackupConfig> {
  return resolveBackupConfig(await readStoredBackupConfig(database), env);
}

export type BackupConfigInput = {
  destination:
    | { kind: "none" }
    | { bucket: string; kind: "gcs"; prefix: string }
    /** No token keeps the one already saved. */
    | { kind: "blob"; token: string | null };
  enabled: boolean;
  keepDays: number;
};

// Bucket names: 3 to 63 lowercase letters, digits, dashes, underscores and
// dots, starting and ending with a letter or digit.
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/** Reads the form in Settings, or says what is wrong with it. */
export function parseBackupConfigInput(body: unknown): BackupConfigInput {
  const input = (typeof body === "object" && body !== null ? body : {}) as {
    destination?: unknown;
    enabled?: unknown;
    keepDays?: unknown;
  };
  const destination = (
    typeof input.destination === "object" && input.destination !== null
      ? input.destination
      : {}
  ) as { bucket?: unknown; kind?: unknown; prefix?: unknown; token?: unknown };
  const keepDays = parseKeepDays(input.keepDays);

  if (keepDays === null) {
    throw new BackupConfigError("Keep copies for 1 to 3650 days.");
  }

  const enabled = input.enabled !== false;

  switch (destination.kind) {
    case "none":
      return { destination: { kind: "none" }, enabled, keepDays };
    case "gcs": {
      const bucket =
        typeof destination.bucket === "string"
          ? destination.bucket
              .trim()
              .replace(/^gs:\/\//, "")
              .replace(/\/+$/, "")
          : "";

      if (!BUCKET_NAME.test(bucket)) {
        throw new BackupConfigError(
          "Enter the bucket's name, such as my-signudoc-backups.",
        );
      }

      let prefix: string;

      try {
        prefix = normalizeGcsPrefix(
          typeof destination.prefix === "string" ? destination.prefix : "",
        );
      } catch {
        throw new BackupConfigError("That folder name is not valid.");
      }

      return {
        destination: { bucket, kind: "gcs", prefix },
        enabled,
        keepDays,
      };
    }
    case "blob": {
      const token =
        typeof destination.token === "string" ? destination.token.trim() : "";

      if (token && !token.startsWith("vercel_blob_rw_")) {
        throw new BackupConfigError(
          "Paste the backup store's read-write token. It starts with vercel_blob_rw_.",
        );
      }

      return {
        destination: { kind: "blob", token: token || null },
        enabled,
        keepDays,
      };
    }
    default:
      throw new BackupConfigError("Choose where backups go.");
  }
}

type Actor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

/**
 * The target a form describes, using the saved token when the form leaves
 * it out. Null for "none".
 */
export function targetFromInput(
  destination: BackupConfigInput["destination"],
  stored: StoredBackupConfig | null,
  env: EnvSource = process.env,
): BackupTarget | null {
  if (destination.kind === "none") {
    return null;
  }

  if (destination.kind === "gcs") {
    return destination;
  }

  const token =
    destination.token ??
    (stored?.destination === "blob" && stored.blobTokenEncrypted
      ? decryptBackupToken(stored.blobTokenEncrypted, env)
      : null);

  if (!token) {
    throw new BackupConfigError(
      "Paste the backup store's read-write token. It starts with vercel_blob_rw_.",
    );
  }

  return { kind: "blob", token };
}

/** Saves the administrator's choice, and records what changed. */
export async function saveBackupConfig(
  actor: Actor,
  input: BackupConfigInput,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbPool; env?: EnvSource } = {},
): Promise<void> {
  const envTarget = readBackupTargetFromEnv(env);
  const envKeepDays = readKeepDaysFromEnv(env);

  await withTransaction(async (tx) => {
    // Locked until commit, so two saves cannot cross.
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [
      BACKUP_RUN_LOCK_ID + 1,
    ]);

    const stored = await readStoredBackupConfig(tx);
    let destination: BackupDestinationKind = stored?.destination ?? "none";
    let gcsBucket = stored?.gcsBucket ?? null;
    let gcsPrefix = stored?.gcsPrefix ?? "";
    let blobTokenEncrypted = stored?.blobTokenEncrypted ?? null;

    // What the deployment fixes is left as it is.
    if (!envTarget) {
      const target = targetFromInput(input.destination, stored, env);

      if (target && isBackupStoreTheAppStore({ target }, env)) {
        throw new BackupConfigError(
          target.kind === "gcs"
            ? "That is the bucket this install keeps its own files in. Back up to a different bucket, ideally in another project."
            : "That token is for this install's own Blob store. Make a second store for backups and use its token.",
        );
      }

      destination = input.destination.kind;
      gcsBucket = target?.kind === "gcs" ? target.bucket : null;
      gcsPrefix = target?.kind === "gcs" ? target.prefix : "";
      blobTokenEncrypted =
        target?.kind === "blob"
          ? input.destination.kind === "blob" && input.destination.token
            ? encryptBackupToken(target.token, env)
            : (stored?.blobTokenEncrypted ?? null)
          : null;
    }

    const keepDays =
      envKeepDays === null
        ? input.keepDays
        : (stored?.keepDays ?? input.keepDays);
    const changes: string[] = [];

    if (destination !== (stored?.destination ?? "none")) {
      changes.push("destination");
    }

    if (
      gcsBucket !== (stored?.gcsBucket ?? null) ||
      gcsPrefix !== (stored?.gcsPrefix ?? "")
    ) {
      changes.push("bucket");
    }

    if (blobTokenEncrypted !== (stored?.blobTokenEncrypted ?? null)) {
      changes.push("blob_token");
    }

    if (keepDays !== (stored?.keepDays ?? DEFAULT_KEEP_DAYS)) {
      changes.push("keep_days");
    }

    if (input.enabled !== (stored?.enabled ?? true)) {
      changes.push(input.enabled ? "daily_run_on" : "daily_run_off");
    }

    if (changes.length === 0 && stored) {
      return;
    }

    await tx.query(
      `
        INSERT INTO backup_settings (
          id, destination, gcs_bucket, gcs_prefix, blob_token_encrypted,
          keep_days, enabled, updated_at, updated_by
        )
        VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          destination = excluded.destination,
          gcs_bucket = excluded.gcs_bucket,
          gcs_prefix = excluded.gcs_prefix,
          blob_token_encrypted = excluded.blob_token_encrypted,
          keep_days = excluded.keep_days,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
      [
        destination,
        gcsBucket,
        gcsPrefix,
        blobTokenEncrypted,
        keepDays,
        input.enabled,
        now(),
        actor.userId,
      ],
    );

    // The token itself never goes in the audit trail.
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "backup_settings_changed",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          bucket: gcsBucket,
          changes,
          destination,
          enabled: input.enabled,
          keepDays,
          prefix: gcsPrefix || null,
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

export type BackupRunStatus = "failed" | "partial" | "running" | "succeeded";

export type BackupRun = {
  destination: string;
  error: string | null;
  finishedAt: number | null;
  id: string;
  startedAt: number;
  status: BackupRunStatus;
  summary: Partial<BackupSummary> | null;
  trigger: "manual" | "schedule";
};

export async function listBackupRuns(
  limit = 10,
  database: DbExecutor = getDb(),
): Promise<BackupRun[]> {
  const runs = await queryMany<BackupRun>(
    database,
    `
      SELECT
        id,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        status,
        trigger,
        destination,
        summary,
        error
      FROM backup_runs
      ORDER BY started_at DESC, id
      LIMIT $1
    `,
    [limit],
  );

  // A run that never finished was stopped (a deploy, a timeout).
  return runs.map((run): BackupRun =>
    run.status === "running" && run.startedAt < now() - STALE_RUN_SECONDS
      ? {
          ...run,
          error: "The run stopped before it finished.",
          status: "failed",
        }
      : run,
  );
}

function describeTarget(target: BackupTarget): string {
  return target.kind === "gcs"
    ? `gs://${target.bucket}/${target.prefix}`
    : "Vercel Blob";
}

/** Marks a run as started, or returns null when another one is running. */
async function startRun(
  trigger: BackupRun["trigger"],
  target: BackupTarget,
  database: DbPool,
): Promise<string | null> {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [BACKUP_RUN_LOCK_ID]);

    // Runs never overlap (the lock above), so each one starts after the
    // one before. Two in the same second would tie on started_at, which
    // every list is ordered by, so the later one is recorded a second on
    // and the newest run always comes first.
    const previous = await queryOne<{ startedAt: string | null }>(
      tx,
      `SELECT max(started_at)::text AS "startedAt" FROM backup_runs`,
    );
    const startedAt = Math.max(
      now(),
      previous?.startedAt ? Number(previous.startedAt) + 1 : 0,
    );

    await tx.query(
      `
        UPDATE backup_runs
        SET status = 'failed', finished_at = $1,
          error = 'The run stopped before it finished.'
        WHERE status = 'running' AND started_at < $2
      `,
      [startedAt, startedAt - STALE_RUN_SECONDS],
    );

    const running = await queryOne<{ id: string }>(
      tx,
      `SELECT id FROM backup_runs WHERE status = 'running' LIMIT 1`,
    );

    if (running) {
      return null;
    }

    const id = randomUUID();

    await tx.query(
      `
        INSERT INTO backup_runs (id, started_at, status, trigger, destination)
        VALUES ($1, $2, 'running', $3, $4)
      `,
      [id, startedAt, trigger, describeTarget(target)],
    );

    return id;
  }, database);
}

async function finishRun(
  id: string,
  outcome: {
    error: string | null;
    status: Exclude<BackupRunStatus, "running">;
    summary: BackupSummary | null;
  },
  database: DbPool,
) {
  await database.query(
    `
      UPDATE backup_runs
      SET status = $2, finished_at = $3, summary = $4, error = $5
      WHERE id = $1
    `,
    [
      id,
      outcome.status,
      now(),
      outcome.summary
        ? JSON.stringify({
            ...outcome.summary,
            fileFailures: outcome.summary.fileFailures.slice(0, 20),
          })
        : null,
      outcome.error,
    ],
  );
  await database.query(
    `
      DELETE FROM backup_runs
      WHERE id NOT IN (
        SELECT id FROM backup_runs ORDER BY started_at DESC LIMIT $1
      )
    `,
    [KEPT_RUNS],
  );
}

/**
 * A failure in words that are safe to show and keep: a status code or the
 * name of what is missing, never a response body or a secret.
 */
export function describeBackupError(error: unknown): string {
  if (error instanceof GcsRequestError) {
    if (error.status === 401 || error.status === 403) {
      return `Google Cloud Storage refused access (${String(error.status)}). The app's service account needs ${BACKUP_BUCKET_ROLE} on the bucket.`;
    }

    if (error.status === 404) {
      return "Google Cloud Storage found no such bucket (404).";
    }

    return error.message;
  }

  if (error instanceof ServiceConfigurationError) {
    return error.message;
  }

  // The Blob SDK's errors are fixed sentences that name no secret.
  if (error instanceof Error && error.name.startsWith("Blob")) {
    return error.message;
  }

  return error instanceof Error && error.name !== "Error"
    ? `The backup failed (${error.name}).`
    : "The backup failed.";
}

export type BackupRunOutcome =
  | { status: "busy" }
  | { status: "disabled" }
  | { message: string; status: "failed" }
  | { message: string; status: "misconfigured" }
  | { status: "not_configured" }
  | { status: "finished"; summary: BackupSummary };

/**
 * Runs the backup to wherever it is set to go, and records the run. Used by
 * the daily call and by "Run backup now".
 */
export async function runConfiguredBackup({
  claimSlot,
  createSource = () => createAppFilesStore(),
  createTarget = (target: BackupTarget) => createBackupTargetStore(target),
  database = getDb(),
  deadline,
  env = process.env,
  trigger,
}: {
  /**
   * Called once a run is about to start, after the checks that decide whether
   * one can happen at all. Returning false skips the run, reported as busy.
   */
  claimSlot?: () => Promise<boolean>;
  createSource?: () => BackupStore;
  createTarget?: (target: BackupTarget) => BackupStore;
  database?: DbPool;
  deadline: number;
  env?: EnvSource;
  trigger: BackupRun["trigger"];
}): Promise<BackupRunOutcome> {
  const config = await getBackupConfig(database, env);

  if (!config.target) {
    return config.tokenUnreadable
      ? {
          message:
            "The saved Blob token can no longer be read, because the auth secret changed. Enter it again in Settings.",
          status: "misconfigured",
        }
      : { status: "not_configured" };
  }

  if (trigger === "schedule" && !config.enabled) {
    return { status: "disabled" };
  }

  if (isBackupStoreTheAppStore({ target: config.target }, env)) {
    return {
      message:
        config.target.kind === "gcs"
          ? "The backup bucket is the bucket this install keeps its own files in."
          : "The backup Blob token is for this install's own store.",
      status: "misconfigured",
    };
  }

  if (claimSlot && !(await claimSlot())) {
    return { status: "busy" };
  }

  const id = await startRun(trigger, config.target, database);

  if (!id) {
    return { status: "busy" };
  }

  try {
    const summary = await runBackup({
      database,
      deadline,
      keepDays: config.keepDays,
      source: createSource(),
      target: createTarget(config.target),
    });

    await finishRun(
      id,
      {
        error:
          summary.fileFailures.length > 0
            ? `${String(summary.fileFailures.length)} files could not be copied.`
            : null,
        status: summary.fileFailures.length > 0 ? "partial" : "succeeded",
        summary,
      },
      database,
    );

    return { status: "finished", summary };
  } catch (error) {
    const message = describeBackupError(error);

    await finishRun(
      id,
      { error: message, status: "failed", summary: null },
      database,
    ).catch(() => undefined);

    return { message, status: "failed" };
  }
}

export type BackupTestResult =
  | { ok: true }
  | {
      hint: string | null;
      message: string;
      ok: false;
      step: "delete" | "list" | "read" | "write";
    };

/** The command that grants the app's service account what it needs. */
export function describeBucketGrant(
  bucket: string,
  serviceAccountEmail: string | null,
): string {
  const member = serviceAccountEmail
    ? `serviceAccount:${serviceAccountEmail}`
    : "serviceAccount:<the service account the app runs as>";

  return `Grant ${BACKUP_BUCKET_ROLE} on gs://${bucket} to ${serviceAccountEmail ?? "the service account the app runs as"}: gcloud storage buckets add-iam-policy-binding gs://${bucket} --member=${member} --role=${BACKUP_BUCKET_ROLE}`;
}

/**
 * Writes a small file to the target, lists it, reads it back and deletes
 * it: everything a backup does there.
 */
export async function testBackupTarget(
  target: BackupTarget,
  {
    createTarget = (value: BackupTarget) => createBackupTargetStore(value),
    env = process.env,
    serviceAccountEmail = () => findServiceAccountEmail(),
  }: {
    createTarget?: (target: BackupTarget) => BackupStore;
    env?: EnvSource;
    serviceAccountEmail?: () => Promise<string | null>;
  } = {},
): Promise<BackupTestResult> {
  if (isBackupStoreTheAppStore({ target }, env)) {
    return {
      hint: null,
      message:
        target.kind === "gcs"
          ? "That is the bucket this install keeps its own files in."
          : "That token is for this install's own Blob store.",
      ok: false,
      step: "write",
    };
  }

  const probe = `probe/${randomUUID()}.txt`;
  const content = `SignuDoc backup test ${new Date().toISOString()}`;
  let step: "delete" | "list" | "read" | "write" = "write";

  try {
    const store = createTarget(target);

    await store.put(probe, content, { contentType: "text/plain" });

    step = "list";
    const listed = await store.list({ prefix: probe });

    if (!listed.blobs.some((blob) => blob.pathname === probe)) {
      throw new Error("The test file was written but is not listed.");
    }

    step = "read";
    const found = await store.get(probe);

    if (!found || (await new Response(found.stream).text()) !== content) {
      throw new Error("The test file did not read back as written.");
    }

    step = "delete";
    await store.delete([probe]);

    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "Error"
        ? error.message
        : describeBackupError(error);
    let hint: string | null = null;

    if (target.kind === "gcs") {
      hint =
        error instanceof ServiceConfigurationError
          ? "This install has no Google credentials. Run it on Google Cloud (Cloud Run), or set GOOGLE_SERVICE_ACCOUNT_KEY."
          : describeBucketGrant(target.bucket, await serviceAccountEmail());
    } else {
      hint =
        "Check that the token is the read-write token of a private Blob store, and that the store still exists.";
    }

    return { hint, message, ok: false, step };
  }
}

export type BackupSetupState = "done" | "failing" | "not_configured";

export type BackupSetupStatus = { message: string; state: BackupSetupState };

/** Whether backups are set up and working, for Settings and first-run setup. */
export function summarizeBackupStatus(
  config: EffectiveBackupConfig,
  runs: BackupRun[],
  at: number = now(),
): BackupSetupStatus {
  if (!config.target) {
    return config.tokenUnreadable
      ? {
          message:
            "The saved Blob token can no longer be read. Enter it again.",
          state: "failing",
        }
      : { message: "Backups are not set up.", state: "not_configured" };
  }

  if (!config.enabled) {
    return {
      message: "The daily backup is turned off.",
      state: "not_configured",
    };
  }

  const finished = runs.filter((run) => run.status !== "running");
  const last = finished[0];

  if (!last) {
    return {
      message: "Set up. The first backup runs with the next daily run.",
      state: "done",
    };
  }

  if (last.status === "failed" || last.status === "partial") {
    return {
      message: last.error ?? "The last backup failed.",
      state: "failing",
    };
  }

  if (last.startedAt < at - OVERDUE_SECONDS) {
    return {
      message:
        "No backup has finished in two days. Check that the daily call reaches /api/internal/backup.",
      state: "failing",
    };
  }

  return { message: "The last backup succeeded.", state: "done" };
}

export async function getBackupSetupStatus(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<BackupSetupStatus> {
  const [config, runs] = await Promise.all([
    getBackupConfig(database, env),
    listBackupRuns(5, database),
  ]);

  return summarizeBackupStatus(config, runs);
}

/** What the Backups section of Settings shows. Never includes a token. */
export type BackupSettingsView = {
  destination:
    | { kind: "none" }
    | { bucket: string; kind: "gcs"; prefix: string }
    | { hasToken: boolean; kind: "blob" };
  enabled: boolean;
  keepDays: number;
  locked: { destination: boolean; keepDays: boolean };
  /** Where the install keeps its own files, for the suggested destination. */
  primaryDriver: ReturnType<typeof resolveStorageDriver> | null;
  runs: BackupRun[];
  serviceAccountEmail: string | null;
  status: BackupSetupStatus;
};

export async function getBackupSettingsView(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<BackupSettingsView> {
  const [stored, runs, serviceAccountEmail] = await Promise.all([
    readStoredBackupConfig(database),
    listBackupRuns(10, database),
    findServiceAccountEmail(),
  ]);
  const config = resolveBackupConfig(stored, env);
  let primaryDriver: BackupSettingsView["primaryDriver"] = null;

  try {
    primaryDriver = resolveStorageDriver(env);
  } catch {
    primaryDriver = null;
  }

  let destination: BackupSettingsView["destination"] = { kind: "none" };

  if (config.target?.kind === "gcs") {
    destination = {
      bucket: config.target.bucket,
      kind: "gcs",
      prefix: config.target.prefix,
    };
  } else if (config.target?.kind === "blob" || stored?.destination === "blob") {
    destination = { hasToken: Boolean(config.target), kind: "blob" };
  }

  return {
    destination,
    enabled: config.enabled,
    keepDays: config.keepDays,
    locked: config.locked,
    primaryDriver,
    runs,
    serviceAccountEmail,
    status: summarizeBackupStatus(config, runs),
  };
}
