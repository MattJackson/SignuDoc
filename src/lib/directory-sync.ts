import type { PoolClient } from "pg";
import { z } from "zod";

import {
  readPasswordSignInPolicy,
  resolveWorkspaceDomains,
} from "./auth/sso.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  getIntegrationSettings,
  type IntegrationSettings,
} from "./integration-settings.ts";
import {
  DirectoryError,
  getDirectoryClient,
  type DirectoryClient,
  type DirectoryUser,
} from "./integrations/google/directory.ts";
import { findRecordKeeper, ROLE_CHANGE_LOCK_ID } from "./people.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { readStoredSettings } from "./settings.ts";
import { getEmailDomain } from "./signup-policy.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// Offboarding from the Google Workspace directory. An internal job
// (/api/internal/directory-sync, on a schedule) asks the directory about the
// accounts here whose address is in one of the organization's Workspace
// domains. When the directory says someone is suspended, archived, or no
// longer there:
//
// - their sign-in is blocked, with a password and with single sign-on alike
//   (directory-block.ts, auth/server.ts), and their sessions are ended;
// - their envelopes that are still out for signature, and their drafts, go
//   to their manager (the directory's "manager" relation) when the manager
//   has an account here that can still be used, or else to an
//   administrator. Finished envelopes stay where they are: closing the
//   account hands those over (retention.ts).
//
// When the directory later says the account is active again, the block is
// lifted. The envelopes stay with whoever has them now.
//
// It holds back wherever a mistake would be hard to undo:
//
// - It is off until an administrator turns it on, and it needs the
//   directory to be readable.
// - Only accounts in the Workspace domains are asked about. With no domains
//   known, nobody is: an account elsewhere is not "missing" from the
//   directory, it was never in it.
// - A lookup that fails is "unknown", never "gone". When more than half of
//   them fail, the run stops and changes nothing: the directory, or the
//   access to it, is not working.
// - At most a few accounts are offboarded per run (DIRECTORY_SYNC_MAX_PER_RUN,
//   10 unless set). A directory that suddenly answered "no such user" for
//   everyone, for a wrong customer or a broken role, would block ten people
//   and not the whole organization. The rest wait for the next run.
// - The last administrator who can still sign in is never blocked, and nor
//   are the break-glass addresses kept for when the identity provider is
//   down.
// - A dry run (?dryRun=1) does everything inside transactions that are
//   rolled back, and reports what would have been done.
//
// Every change is in the site audit trail, and each envelope that moves has
// a "handed_over" event in its own.
//
// Envelopes given to an administrator are marked as handed over, like the
// finished ones of a closed account, so they move on again if that
// administrator stops being one (people.ts). Envelopes given to a manager
// are not marked: they become the manager's own work, as if the manager had
// sent them, and stay with the manager if the manager is ever an
// administrator who stops being one. An envelope that was already marked
// (it came from a closed account) goes to an administrator, never to a
// manager, who was not party to it.
//
// An envelope's files stay where they are in storage. Every key that is
// read back is stored on the envelope's row, or derived from the original's
// key (buildEnvelopeThumbnailKey), not from who owns the envelope now, so
// nothing is lost or orphaned by the move. Files made after the move, like
// the signed PDF, go under the new owner's folder.

export const DIRECTORY_SYNC_ADVISORY_LOCK_ID = 746108350;
export const DEFAULT_MAX_PER_RUN = 10;
export const MAX_PER_RUN_LIMIT = 500;
/**
 * How many accounts one run asks about, those asked about longest ago
 * first. A large organization is gone through over several runs, so a run
 * stays well inside a request's time limit and Google's quota.
 */
export const MAX_LOOKUPS_PER_RUN = 1000;
const LOOKUP_BATCH_SIZE = 5;
/** Hand-over attempts when the chosen administrator changes in between. */
const MAX_KEEPER_ATTEMPTS = 5;
const OPEN_STATUSES = ["draft", "sent"] as const;

export type DirectorySyncReason =
  "directory_archived" | "directory_deleted" | "directory_suspended";

export type DirectoryStanding =
  | { managerEmail: string | null; state: "active" }
  | {
      managerEmail: string | null;
      reason: DirectorySyncReason;
      state: "offboarded";
    }
  | { error: string; state: "unknown" };

/** What one directory answer means here. */
export function readDirectoryStanding(
  entry: DirectoryUser | null,
): DirectoryStanding {
  if (!entry) {
    return {
      managerEmail: null,
      reason: "directory_deleted",
      state: "offboarded",
    };
  }

  if (entry.archived) {
    return {
      managerEmail: entry.managerEmail,
      reason: "directory_archived",
      state: "offboarded",
    };
  }

  if (entry.suspended) {
    return {
      managerEmail: entry.managerEmail,
      reason: "directory_suspended",
      state: "offboarded",
    };
  }

  return { managerEmail: entry.managerEmail, state: "active" };
}

/** Asks the directory, turning any failure into "unknown". */
export async function lookUpStanding(
  directory: DirectoryClient,
  email: string,
): Promise<DirectoryStanding> {
  try {
    return readDirectoryStanding(await directory.getUser(email));
  } catch (error) {
    // Google's own messages can echo what was sent; ours carry the status.
    return {
      error:
        error instanceof DirectoryError
          ? error.message
          : "The directory could not be asked.",
      state: "unknown",
    };
  }
}

export type DirectorySyncSetting = {
  enabled: boolean;
  source: "default" | "env" | "settings";
};

/** DIRECTORY_SYNC, when set, wins over the choice made in the app. */
export function readDirectorySyncSetting(
  env: EnvSource = process.env,
  stored: Pick<IntegrationSettings, "people.directorySync"> | null = null,
): DirectorySyncSetting {
  const envChoice = readEnv(env, "DIRECTORY_SYNC")?.toLowerCase();
  const storedChoice = stored?.["people.directorySync"]?.trim().toLowerCase();

  return {
    enabled: (envChoice ?? storedChoice) === "on",
    source: envChoice ? "env" : storedChoice ? "settings" : "default",
  };
}

/**
 * The most accounts one run may offboard: DIRECTORY_SYNC_MAX_PER_RUN, kept
 * between 1 and 500, or 10. A caller's own limit can only lower it.
 */
export function resolveMaxPerRun(
  env: EnvSource = process.env,
  requested: number | null = null,
): number {
  const raw = readEnv(env, "DIRECTORY_SYNC_MAX_PER_RUN");
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  const configured = Number.isFinite(parsed)
    ? Math.min(MAX_PER_RUN_LIMIT, Math.max(1, parsed))
    : DEFAULT_MAX_PER_RUN;

  if (requested === null || !Number.isInteger(requested) || requested < 1) {
    return configured;
  }

  return Math.min(configured, requested);
}

export type DirectorySyncRequest = { dryRun: boolean; limit: number | null };

const requestBodySchema = z.strictObject({
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_PER_RUN_LIMIT).optional(),
});

function readFlag(value: string | null): boolean {
  return (
    value !== null &&
    ["1", "on", "true", "yes"].includes(value.trim().toLowerCase())
  );
}

/**
 * What the caller asked for, from the query string (?dryRun=1&limit=3) or
 * a JSON body ({ "dryRun": true, "limit": 3 }). A dry run asked for in
 * either place is a dry run.
 */
export function parseDirectorySyncRequest(
  searchParams: URLSearchParams,
  body: unknown,
):
  { ok: true; request: DirectorySyncRequest } | { message: string; ok: false } {
  const parsed = requestBodySchema.safeParse(body ?? {});

  if (!parsed.success) {
    return {
      message:
        'The body must be JSON like { "dryRun": true, "limit": 5 }, or empty.',
      ok: false,
    };
  }

  const limitParam = searchParams.get("limit");
  let limit = parsed.data.limit ?? null;

  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam.trim()) || Number(limitParam) < 1) {
      return { message: "limit must be a whole number above 0.", ok: false };
    }

    const fromQuery = Number.parseInt(limitParam, 10);

    limit = limit === null ? fromQuery : Math.min(limit, fromQuery);
  }

  return {
    ok: true,
    request: {
      dryRun:
        readFlag(searchParams.get("dryRun")) || parsed.data.dryRun === true,
      limit,
    },
  };
}

/** Whether the address is in one of the Workspace domains. */
export function isWorkspaceAddress(
  email: string,
  domains: readonly string[],
): boolean {
  const domain = getEmailDomain(email);

  return domain !== null && domains.includes(domain);
}

function parseAddressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The break-glass addresses: the ones kept to sign in with a password when
 * password sign-in is off. Both lists count, the environment's and the
 * app's, and whether or not password sign-in is off right now: an address
 * someone set aside for emergencies is never offboarded by a job.
 */
export function collectBreakGlassAddresses(
  env: EnvSource = process.env,
  stored: IntegrationSettings | null = null,
): Set<string> {
  return new Set([
    ...readPasswordSignInPolicy(env, stored).allowedEmails,
    ...parseAddressList(readEnv(env, "PASSWORD_SIGN_IN_ALLOWED_EMAILS")),
    ...parseAddressList(stored?.["sso.passwordAllowedEmails"]),
  ]);
}

/**
 * True when so many lookups have failed that none of the answers should be
 * acted on: more than half of them.
 */
export function directoryLooksBroken(asked: number, failed: number): boolean {
  return asked > 0 && failed * 2 > asked;
}

export type SyncAccount = {
  blockedAt: number | null;
  email: string;
  id: string;
  name: string;
  /** Drafts and envelopes out for signature. */
  openEnvelopes: number;
  role: "admin" | "user";
};

export type AccountPlan =
  | { kind: "nothing" }
  | {
      kind: "offboard";
      managerEmail: string | null;
      reason: DirectorySyncReason;
    }
  | { kind: "restore"; why: "break_glass" | "directory_active" }
  | { error: string; kind: "skip"; why: "lookup_failed" }
  | { kind: "skip"; why: "break_glass" };

/**
 * What to do about one account, from what the directory said. The cap and
 * the last administrator are looked at later, when the change is made.
 */
export function planAccount(
  account: SyncAccount,
  standing: DirectoryStanding,
  breakGlass: ReadonlySet<string>,
): AccountPlan {
  if (breakGlass.has(account.email.trim().toLowerCase())) {
    // A block from before the address was set aside is lifted: getting in
    // when nothing else works is what the address is for. Otherwise it is
    // only worth a line when the directory says the account has gone.
    if (account.blockedAt !== null) {
      return { kind: "restore", why: "break_glass" };
    }

    return standing.state === "offboarded"
      ? { kind: "skip", why: "break_glass" }
      : { kind: "nothing" };
  }

  if (standing.state === "unknown") {
    return { error: standing.error, kind: "skip", why: "lookup_failed" };
  }

  if (standing.state === "active") {
    return account.blockedAt !== null
      ? { kind: "restore", why: "directory_active" }
      : { kind: "nothing" };
  }

  // Already blocked, with nothing left to hand over: done on an earlier run.
  if (account.blockedAt !== null && account.openEnvelopes === 0) {
    return { kind: "nothing" };
  }

  return {
    kind: "offboard",
    managerEmail: standing.managerEmail,
    reason: standing.reason,
  };
}

export type HandedOverEnvelope = {
  envelopeId: string;
  handedTo: "administrator" | "manager";
  status: "draft" | "sent";
  toEmail: string;
  toUserId: string;
};

export type DirectorySyncAccountResult = {
  email: string;
  userId: string;
} & (
  | {
      action: "offboarded";
      /** False when the account was already blocked by an earlier run. */
      blocked: boolean;
      envelopes: HandedOverEnvelope[];
      /**
       * Open envelopes nobody could take: no manager and no administrator,
       * or waiting for a manager who could not be looked up.
       */
      envelopesKept: number;
      reason: DirectorySyncReason;
      sessionsEnded: number;
    }
  | { action: "restored"; why: "break_glass" | "directory_active" }
  | { action: "deferred"; reason: DirectorySyncReason }
  | {
      action: "skipped";
      error?: string;
      reason?: DirectorySyncReason;
      why: "break_glass" | "last_admin" | "lookup_failed" | "missing";
    }
);

export type DirectorySyncCounts = {
  checked: number;
  deferred: number;
  envelopesHandedOver: number;
  lookupFailures: number;
  offboarded: number;
  restored: number;
  skipped: number;
};

export type DirectorySyncOutcome =
  | { reason: "no_directory" | "off"; status: "not_configured" }
  | { status: "no_domains" }
  | { status: "already_running" }
  | {
      /** Accounts changed, or that would be in a dry run. Not the quiet ones. */
      accounts: DirectorySyncAccountResult[];
      counts: DirectorySyncCounts;
      dryRun: boolean;
      maxPerRun: number;
      /** More accounts are in the domains than one run asks about. */
      moreToCheck: boolean;
      ranAt: number;
      status: "ran";
      /** Too many lookups failed, so nothing was changed. */
      stoppedEarly: boolean;
    };

/**
 * The HTTP status a scheduler should see for an outcome: a sync that is turned
 * on but cannot run, or that stopped because the directory failed, shows as
 * failed there.
 */
export function directorySyncHttpStatus(outcome: DirectorySyncOutcome): number {
  if (outcome.status === "no_domains") {
    return 503;
  }

  if (outcome.status === "not_configured") {
    return outcome.reason === "no_directory" ? 503 : 200;
  }

  if (outcome.status === "ran" && outcome.stoppedEarly) {
    return 502;
  }

  return 200;
}

export type RunDirectorySyncOptions = {
  database?: DbPool;
  /** Replaced in tests. Null means the directory is not set up. */
  directory?: DirectoryClient | null;
  dryRun?: boolean;
  env?: EnvSource;
  /** A caller's own cap, which can only lower the configured one. */
  limit?: number | null;
  now?: () => number;
  /** The sign-up rule's domains. Read from the settings when not given. */
  signupDomains?: readonly string[];
  /** The stored integration settings. Read when not given. */
  stored?: IntegrationSettings;
};

/** Thrown to roll a dry run's transaction back, carrying what it did. */
class DryRunRollback<T> extends Error {
  readonly result: T;

  constructor(result: T) {
    super("Dry run: rolled back.");
    this.name = "DryRunRollback";
    this.result = result;
  }
}

/**
 * Runs `work` in a transaction that commits, or in a dry run one that is
 * rolled back after `work` has done everything it would have.
 */
async function inTransaction<T>(
  dryRun: boolean,
  database: DbPool,
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(async (tx) => {
      const result = await work(tx);

      if (dryRun) {
        throw new DryRunRollback(result);
      }

      return result;
    }, database);
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return error.result as T;
    }

    throw error;
  }
}

async function listAccountsToCheck(
  domains: readonly string[],
  database: DbExecutor,
): Promise<{ accounts: SyncAccount[]; total: number }> {
  const inDomains = `lower(substring(u.email from '@([^@]+)$')) = ANY($1::text[])`;
  const accounts = await queryMany<SyncAccount>(
    database,
    `
      SELECT
        u.id,
        u.email,
        u.name,
        CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'user' END AS role,
        u.directory_blocked_at AS "blockedAt",
        (
          SELECT count(*)::int
          FROM envelopes e
          WHERE e.user_id = u.id AND e.status = ANY($3::text[])
        ) AS "openEnvelopes"
      FROM "user" u
      WHERE ${inDomains}
      ORDER BY u.directory_checked_at ASC NULLS FIRST, u."createdAt" ASC, u.id ASC
      LIMIT $2
    `,
    [domains, MAX_LOOKUPS_PER_RUN, OPEN_STATUSES],
  );
  const total = await queryOne<{ total: number }>(
    database,
    `SELECT count(*)::int AS total FROM "user" u WHERE ${inDomains}`,
    [domains],
  );

  return { accounts, total: total?.total ?? accounts.length };
}

type Recipient = { email: string; id: string };

/**
 * The manager, when they have an account here that can still be used: not
 * blocked, not being closed, and not one a dry run would have blocked
 * before this. Their row is held so they cannot be blocked or closed until
 * the envelopes have moved.
 */
async function lockUsableManager(
  tx: DbExecutor,
  managerEmail: string,
  fromUserId: string,
  excludedIds: readonly string[],
): Promise<Recipient | null> {
  return queryOne<Recipient>(
    tx,
    `
      SELECT u.id, u.email
      FROM "user" u
      WHERE lower(u.email) = $1
        AND u.id <> $2
        AND u.id <> ALL($3::text[])
        AND u.directory_blocked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
        )
      ORDER BY u.id
      LIMIT 1
      FOR SHARE OF u
    `,
    [managerEmail.trim().toLowerCase(), fromUserId, excludedIds],
  );
}

/**
 * An administrator to take the envelopes, chosen as the records of a closed
 * account are (findRecordKeeper), and held while they move. The role-change
 * lock is held too, so the role cannot be taken away in between; the check
 * is made again on the held row anyway, as retention.ts does.
 */
async function lockKeeper(
  tx: DbExecutor,
  excludedIds: readonly string[],
): Promise<Recipient | null> {
  for (let attempt = 0; attempt < MAX_KEEPER_ATTEMPTS; attempt += 1) {
    const keeperId = await findRecordKeeper(excludedIds, tx);

    if (!keeperId) {
      return null;
    }

    const keeper = await queryOne<Recipient>(
      tx,
      `
        SELECT u.id, u.email
        FROM "user" u
        WHERE u.id = $1
          AND u.role = 'admin'
          AND u.directory_blocked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
          )
        FOR SHARE OF u
      `,
      [keeperId],
    );

    if (keeper) {
      return keeper;
    }
  }

  return null;
}

type OffboardInput = {
  account: SyncAccount;
  breakGlass: ReadonlySet<string>;
  /** Accounts a dry run has already blocked, in its imagination. */
  excludedIds: readonly string[];
  /** The manager could not be looked up: their work waits for a later run. */
  managerUnknown?: boolean;
  /** The manager, when the directory says they are still active. */
  managerEmail: string | null;
  now: number;
  reason: DirectorySyncReason;
};

type OffboardResult =
  | {
      blocked: boolean;
      done: true;
      envelopes: HandedOverEnvelope[];
      envelopesKept: number;
      sessionsEnded: number;
    }
  | { done: false; why: "break_glass" | "last_admin" | "missing" };

/**
 * Blocks one account and hands over its open envelopes, all in the one
 * transaction `tx`. Looked at again here, with the rows held, so what was
 * read before the transaction cannot be acted on if it has changed.
 */
async function offboardAccount(
  tx: PoolClient,
  input: OffboardInput,
): Promise<OffboardResult> {
  const { account, now, reason } = input;

  // Taken first, as a role change does: blocking an administrator leaves
  // one fewer, and two of these at once must not both find "one more".
  await tx.query("SELECT pg_advisory_xact_lock($1)", [ROLE_CHANGE_LOCK_ID]);

  const current = await queryOne<{
    blockedAt: number | null;
    email: string;
    name: string;
    role: string;
  }>(
    tx,
    `
      SELECT email, name, role, directory_blocked_at AS "blockedAt"
      FROM "user"
      WHERE id = $1
      FOR UPDATE
    `,
    [account.id],
  );

  if (!current) {
    return { done: false, why: "missing" };
  }

  if (input.breakGlass.has(current.email.trim().toLowerCase())) {
    return { done: false, why: "break_glass" };
  }

  const excludedIds = [account.id, ...input.excludedIds];

  if (current.role === "admin" && !(await findRecordKeeper(excludedIds, tx))) {
    return { done: false, why: "last_admin" };
  }

  // The lock an UPDATE takes, as signing, voiding and reminders take it
  // (signing.ts, lockSentEnvelope): each of those that got in first has
  // finished, and one that comes after waits and then finds the envelope
  // with its new owner. Not FOR UPDATE: a signer's audit event needs a
  // share of this row for its foreign key, and would wait behind it.
  const open = await queryMany<{
    handedOverAt: number | null;
    id: string;
    status: "draft" | "sent";
  }>(
    tx,
    `
      SELECT id, status, handed_over_at AS "handedOverAt"
      FROM envelopes
      WHERE user_id = $1 AND status = ANY($2::text[])
      ORDER BY id
      FOR NO KEY UPDATE
    `,
    [account.id, OPEN_STATUSES],
  );

  const manager =
    input.managerEmail &&
    open.some((envelope) => envelope.handedOverAt === null)
      ? await lockUsableManager(
          tx,
          input.managerEmail,
          account.id,
          input.excludedIds,
        )
      : null;
  // Work that would go to a manager nobody could look up stays where it is
  // for now, not with an administrator.
  const waitsForManager = (envelope: { handedOverAt: number | null }) =>
    envelope.handedOverAt === null && !manager && input.managerUnknown === true;
  const needsKeeper = open.some(
    (envelope) =>
      envelope.handedOverAt !== null ||
      (!manager && !waitsForManager(envelope)),
  );
  const keeper = needsKeeper ? await lockKeeper(tx, excludedIds) : null;
  const handedOver: HandedOverEnvelope[] = [];
  let envelopesKept = 0;

  for (const envelope of open) {
    const toManager = envelope.handedOverAt === null && manager !== null;
    const recipient = toManager ? manager : keeper;

    if (waitsForManager(envelope) || !recipient) {
      envelopesKept += 1;
      continue;
    }

    await tx.query(
      toManager
        ? `UPDATE envelopes SET user_id = $1 WHERE id = $2 AND user_id = $3`
        : `
            UPDATE envelopes
            SET user_id = $1, handed_over_at = COALESCE(handed_over_at, $4)
            WHERE id = $2 AND user_id = $3
          `,
      toManager
        ? [recipient.id, envelope.id, account.id]
        : [recipient.id, envelope.id, account.id, now],
    );

    const handedTo = toManager ? "manager" : "administrator";

    await recordAuditEvent(
      {
        actorType: "system",
        createdAt: now,
        envelopeId: envelope.id,
        event: "handed_over",
        metadata: {
          fromEmail: current.email,
          fromUserId: account.id,
          handedTo,
          reason,
          status: envelope.status,
          toEmail: recipient.email,
          toUserId: recipient.id,
        },
      },
      tx,
    );
    handedOver.push({
      envelopeId: envelope.id,
      handedTo,
      status: envelope.status,
      toEmail: recipient.email,
      toUserId: recipient.id,
    });
  }

  let blocked = false;
  let sessionsEnded = 0;

  if (current.blockedAt === null) {
    await tx.query(
      `
        UPDATE "user"
        SET directory_blocked_at = $2, directory_blocked_reason = $3
        WHERE id = $1
      `,
      [account.id, now, reason],
    );

    // The app's own session check reads the session's row on every
    // request (session-controls.ts), so this signs them out of the app at
    // once. Better Auth's cookie cache can still vouch for a session on
    // its own routes for up to five minutes.
    const ended = await tx.query(`DELETE FROM session WHERE "userId" = $1`, [
      account.id,
    ]);

    blocked = true;
    sessionsEnded = ended.rowCount ?? 0;

    await recordSystemAuditEvent(
      {
        actorEmail: null,
        actorUserId: null,
        createdAt: now,
        event: "directory_sign_in_blocked",
        metadata: {
          reason,
          sessionsEnded,
          source: "google_directory",
          targetEmail: current.email,
          targetName: current.name,
        },
        targetUserId: account.id,
      },
      tx,
    );
  }

  const byRecipient = new Map<string, HandedOverEnvelope[]>();

  for (const envelope of handedOver) {
    byRecipient.set(envelope.toUserId, [
      ...(byRecipient.get(envelope.toUserId) ?? []),
      envelope,
    ]);
  }

  for (const [toUserId, envelopes] of byRecipient) {
    const first = envelopes[0]!;

    await recordSystemAuditEvent(
      {
        actorEmail: null,
        actorUserId: null,
        createdAt: now,
        event: "envelopes_handed_over",
        metadata: {
          count: envelopes.length,
          envelopeIds: envelopes.map((envelope) => envelope.envelopeId),
          fromEmail: current.email,
          fromUserId: account.id,
          handedTo: first.handedTo,
          reason,
          toEmail: first.toEmail,
          toUserId,
        },
        targetUserId: account.id,
      },
      tx,
    );
  }

  return {
    blocked,
    done: true,
    envelopes: handedOver,
    envelopesKept,
    sessionsEnded,
  };
}

/** Lifts the directory's block. False when there was none any more. */
async function restoreAccount(
  tx: PoolClient,
  userId: string,
  why: "break_glass" | "directory_active",
  now: number,
): Promise<boolean> {
  const current = await queryOne<{
    blockedAt: number | null;
    blockedReason: string | null;
    email: string;
    name: string;
  }>(
    tx,
    `
      SELECT
        email,
        name,
        directory_blocked_at AS "blockedAt",
        directory_blocked_reason AS "blockedReason"
      FROM "user"
      WHERE id = $1
      FOR UPDATE
    `,
    [userId],
  );

  if (!current || current.blockedAt === null) {
    return false;
  }

  await tx.query(
    `
      UPDATE "user"
      SET directory_blocked_at = NULL, directory_blocked_reason = NULL
      WHERE id = $1
    `,
    [userId],
  );
  await recordSystemAuditEvent(
    {
      actorEmail: null,
      actorUserId: null,
      createdAt: now,
      event: "directory_sign_in_restored",
      metadata: {
        blockedAt: current.blockedAt,
        previousReason: current.blockedReason,
        source: "google_directory",
        targetEmail: current.email,
        targetName: current.name,
        why,
      },
      targetUserId: userId,
    },
    tx,
  );

  return true;
}

function emptyCounts(): DirectorySyncCounts {
  return {
    checked: 0,
    deferred: 0,
    envelopesHandedOver: 0,
    lookupFailures: 0,
    offboarded: 0,
    restored: 0,
    skipped: 0,
  };
}

/**
 * One run of the directory sync. Never two at once: a second run while one
 * is going answers already_running.
 */
export async function runDirectorySync(
  options: RunDirectorySyncOptions = {},
): Promise<DirectorySyncOutcome> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const stored = options.stored ?? (await getIntegrationSettings(env));

  if (!readDirectorySyncSetting(env, stored).enabled) {
    return { reason: "off", status: "not_configured" };
  }

  const directory =
    options.directory === undefined
      ? getDirectoryClient(env, stored)
      : options.directory;

  if (!directory) {
    return { reason: "no_directory", status: "not_configured" };
  }

  let signupDomains = options.signupDomains;

  if (signupDomains === undefined) {
    const settings = await readStoredSettings(options.database ?? getDb());

    signupDomains =
      settings?.signupMode === "domains" ? settings.allowedEmailDomains : [];
  }

  const { domains } = resolveWorkspaceDomains({ env, signupDomains, stored });

  if (domains.length === 0) {
    return { status: "no_domains" };
  }

  // Asked for only now, so that a run that is not set up needs none.
  const database = options.database ?? getDb();

  // Held on a connection of its own for the whole run, as the daily
  // cleanup's is (retention-job.ts). A transaction lock, so it also holds
  // through a connection pooler.
  const lockClient = await database.connect();

  try {
    await lockClient.query("begin");

    const lock = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [DIRECTORY_SYNC_ADVISORY_LOCK_ID],
    );

    if (!lock.rows[0]?.locked) {
      return { status: "already_running" };
    }

    return await syncAccounts({
      breakGlass: collectBreakGlassAddresses(env, stored),
      database,
      directory,
      domains,
      dryRun,
      maxPerRun: resolveMaxPerRun(env, options.limit ?? null),
      now: now(),
    });
  } finally {
    await lockClient.query("rollback").catch(() => undefined);
    lockClient.release();
  }
}

async function syncAccounts({
  breakGlass,
  database,
  directory,
  domains,
  dryRun,
  maxPerRun,
  now,
}: {
  breakGlass: ReadonlySet<string>;
  database: DbPool;
  directory: DirectoryClient;
  domains: readonly string[];
  dryRun: boolean;
  maxPerRun: number;
  now: number;
}): Promise<Extract<DirectorySyncOutcome, { status: "ran" }>> {
  const { accounts, total } = await listAccountsToCheck(domains, database);
  const counts = emptyCounts();
  const results: DirectorySyncAccountResult[] = [];
  const standings = new Map<string, DirectoryStanding>();
  const looked: Array<{ account: SyncAccount; standing: DirectoryStanding }> =
    [];
  let stoppedEarly = false;

  for (let start = 0; start < accounts.length; start += LOOKUP_BATCH_SIZE) {
    const batch = accounts.slice(start, start + LOOKUP_BATCH_SIZE);
    const answers = await Promise.all(
      batch.map((account) => lookUpStanding(directory, account.email)),
    );

    batch.forEach((account, index) => {
      const standing = answers[index]!;

      standings.set(account.email.trim().toLowerCase(), standing);
      looked.push({ account, standing });

      if (standing.state === "unknown") {
        counts.lookupFailures += 1;
      }
    });

    // Judged once a whole batch is in, so one early failure is not enough.
    if (directoryLooksBroken(looked.length, counts.lookupFailures)) {
      stoppedEarly = true;
      break;
    }
  }

  counts.checked = looked.length;

  if (stoppedEarly) {
    for (const { account, standing } of looked) {
      if (standing.state === "unknown") {
        results.push({
          action: "skipped",
          email: account.email,
          error: standing.error,
          userId: account.id,
          why: "lookup_failed",
        });
      }
    }

    counts.skipped = results.length;
    await recordRun({ counts, dryRun, maxPerRun, now, stoppedEarly }, database);

    return {
      accounts: results,
      counts,
      dryRun,
      maxPerRun,
      moreToCheck: total > looked.length,
      ranAt: now,
      status: "ran",
      stoppedEarly,
    };
  }

  // A manager who has left too is no one to hand work to. Their answer is
  // usually in already; otherwise they are asked once.
  // A manager who could not be looked up is not known to be gone: the
  // account waits for the next run instead of going to an administrator.
  async function managerIfActive(
    email: string | null,
  ): Promise<{ error: string } | { email: string | null }> {
    if (!email) {
      return { email: null };
    }

    const key = email.trim().toLowerCase();
    let standing = standings.get(key);

    if (!standing) {
      standing = await lookUpStanding(directory, key);
      standings.set(key, standing);
    }

    if (standing.state === "unknown") {
      return { error: standing.error };
    }

    return { email: standing.state === "active" ? key : null };
  }

  // In a dry run nothing is committed, so the accounts it would already
  // have blocked are left out by hand when choosing who takes over and
  // whether an administrator is the last one.
  const imaginedBlocked: string[] = [];
  // Skipped for want of an answer about their manager: asked again first.
  const lookupFailedIds = new Set<string>();
  let used = 0;

  for (const { account, standing } of looked) {
    const plan = planAccount(account, standing, breakGlass);

    switch (plan.kind) {
      case "nothing":
        break;
      case "skip":
        if (plan.why === "lookup_failed") {
          results.push({
            action: "skipped",
            email: account.email,
            error: plan.error,
            userId: account.id,
            why: "lookup_failed",
          });
        } else {
          results.push({
            action: "skipped",
            email: account.email,
            userId: account.id,
            why: "break_glass",
          });
        }

        break;
      case "restore": {
        const restored = await inTransaction(dryRun, database, (tx) =>
          restoreAccount(tx, account.id, plan.why, now),
        );

        if (restored) {
          results.push({
            action: "restored",
            email: account.email,
            userId: account.id,
            why: plan.why,
          });
        }

        break;
      }
      case "offboard": {
        if (used >= maxPerRun) {
          results.push({
            action: "deferred",
            email: account.email,
            reason: plan.reason,
            userId: account.id,
          });
          break;
        }

        const manager = await managerIfActive(plan.managerEmail);

        // The block and the end of sessions go ahead; only the hand-over
        // of work that has no manager to go to waits for a later run.
        const managerUnknown = "error" in manager;

        if (managerUnknown) {
          counts.lookupFailures += 1;
          lookupFailedIds.add(account.id);
        }

        const outcome = await inTransaction(dryRun, database, (tx) =>
          offboardAccount(tx, {
            account,
            breakGlass,
            excludedIds: imaginedBlocked,
            managerEmail: "email" in manager ? manager.email : null,
            managerUnknown,
            now,
            reason: plan.reason,
          }),
        );

        if (!outcome.done) {
          results.push({
            action: "skipped",
            email: account.email,
            reason: plan.reason,
            userId: account.id,
            why: outcome.why,
          });
          break;
        }

        if (
          !outcome.blocked &&
          outcome.envelopes.length === 0 &&
          outcome.envelopesKept === 0
        ) {
          break;
        }

        // Only a real change uses a slot; work that stayed with an account
        // that was already blocked is reported but does not count.
        if (outcome.blocked || outcome.envelopes.length > 0) {
          used += 1;

          if (dryRun) {
            imaginedBlocked.push(account.id);
          }
        }

        results.push({
          action: "offboarded",
          blocked: outcome.blocked,
          email: account.email,
          envelopes: outcome.envelopes,
          envelopesKept: outcome.envelopesKept,
          reason: plan.reason,
          sessionsEnded: outcome.sessionsEnded,
          userId: account.id,
        });
        break;
      }
    }
  }

  for (const result of results) {
    switch (result.action) {
      case "deferred":
        counts.deferred += 1;
        break;
      case "offboarded":
        counts.offboarded += 1;
        counts.envelopesHandedOver += result.envelopes.length;
        break;
      case "restored":
        counts.restored += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
    }
  }

  if (!dryRun) {
    // Answered, so the next run starts with the ones asked about longest
    // ago. A failed lookup is not marked, so it is asked again first, and
    // nor is an account left for later by the cap.
    const deferred = new Set(
      results
        .filter((result) => result.action === "deferred")
        .map((result) => result.userId),
    );
    const answered = looked
      .filter(
        ({ account, standing }) =>
          standing.state !== "unknown" &&
          !deferred.has(account.id) &&
          !lookupFailedIds.has(account.id),
      )
      .map(({ account }) => account.id);

    await database.query(
      `UPDATE "user" SET directory_checked_at = $1 WHERE id = ANY($2::text[])`,
      [now, answered],
    );
  }

  await recordRun({ counts, dryRun, maxPerRun, now, stoppedEarly }, database);

  return {
    accounts: results,
    counts,
    dryRun,
    maxPerRun,
    moreToCheck: total > looked.length,
    ranAt: now,
    status: "ran",
    stoppedEarly,
  };
}

/**
 * The run's own line in the site audit trail. A run that found nothing to
 * do is left out, or an hourly schedule would bury everything else; a dry
 * run is always written, as someone asked for it.
 */
async function recordRun(
  {
    counts,
    dryRun,
    maxPerRun,
    now,
    stoppedEarly,
  }: {
    counts: DirectorySyncCounts;
    dryRun: boolean;
    maxPerRun: number;
    now: number;
    stoppedEarly: boolean;
  },
  database: DbPool,
) {
  const eventful =
    counts.offboarded +
      counts.restored +
      counts.deferred +
      counts.skipped +
      counts.lookupFailures >
    0;

  if (!dryRun && !eventful && !stoppedEarly) {
    return;
  }

  await recordSystemAuditEvent(
    {
      actorEmail: null,
      actorUserId: null,
      createdAt: now,
      event: "directory_sync_run",
      metadata: { ...counts, dryRun, maxPerRun, stoppedEarly },
    },
    database,
  );
}
