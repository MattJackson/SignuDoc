import type { PoolClient } from "pg";

import { readPasswordSignInPolicy } from "../auth/sso.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import { findRecordKeeper, ROLE_CHANGE_LOCK_ID } from "../people.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { isMissingSchemaError, readStoredSettings } from "../settings.ts";
import { getEmailDomain, normalizeEmailDomain } from "../signup-policy.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { getWorkspaceContext, resolveCapabilityProvider } from "./registry.ts";
import { resolveWorkspaceSetting, type WorkspaceSettings } from "./settings.ts";
import {
  DirectoryError,
  type DirectoryEntry,
  type WorkspaceDirectory,
} from "./types.ts";

// Offboarding from the organization's directory, through whichever provider
// serves it (registry.ts). A scheduled job (/api/internal/directory-sync)
// asks the directory about the accounts here whose address is in one of the
// organization's domains. When the directory says someone is suspended,
// archived, or no longer there:
//
// - their sign-in is blocked, with a password and with single sign-on alike
//   (directory-block.ts, auth/server.ts), and their sessions are ended;
// - their envelopes that are still out for signature, and their drafts, go
//   to their manager (the directory's managerEmail) when the manager has an
//   account here that can still be used, or else to an administrator.
//   Finished envelopes stay where they are: closing the account hands those
//   over (retention.ts).
//
// When the directory later says the account is active again, the block is
// lifted. The envelopes stay with whoever has them now.
//
// It holds back wherever a mistake would be hard to undo:
//
// - It is off until an administrator turns it on, and needs the directory.
// - Only accounts in the organization's domains are asked about. An account
//   elsewhere is not "missing" from the directory, it was never in it.
// - A lookup that fails is "unknown", never "gone" (DirectoryError). When
//   more than half of them fail, the run stops and changes nothing.
// - At most WORKSPACE_OFFBOARDING_MAX_PER_RUN accounts (10 unless set) are
//   offboarded per run, so a directory that suddenly answers "no such
//   person" for everyone blocks ten people and not the whole organization.
// - The last administrator who can still sign in is never blocked, and nor
//   are the break-glass addresses kept for when the identity provider is
//   down.
//
// Every change is in the site audit trail.
//
// Envelopes given to an administrator are marked as handed over, like the
// finished ones of a closed account, so they move on again if that
// administrator stops being one (people.ts). Envelopes given to a manager
// are not marked: they become the manager's own work. An envelope that was
// already marked goes to an administrator, never to a manager, who was not
// party to it; so do the records a blocked administrator was keeping.

export const OFFBOARDING_ADVISORY_LOCK_ID = 746108350;
export const DEFAULT_MAX_PER_RUN = 10;
export const MAX_PER_RUN_LIMIT = 500;
/**
 * How many accounts one run asks about, those asked about longest ago
 * first. A large organization is gone through over several runs, so a run
 * stays well inside a request's time limit and the provider's quota.
 */
export const MAX_LOOKUPS_PER_RUN = 1000;
const LOOKUP_BATCH_SIZE = 5;
/** Hand-over attempts when the chosen administrator changes in between. */
const MAX_KEEPER_ATTEMPTS = 5;
const OPEN_STATUSES = ["draft", "sent"] as const;

export type OffboardingReason =
  "directory_archived" | "directory_deleted" | "directory_suspended";

export type DirectoryStanding =
  | { managerEmail: string | null; state: "active" }
  | {
      managerEmail: string | null;
      reason: OffboardingReason;
      state: "offboarded";
    }
  | { error: string; state: "unknown" };

/** What one directory answer means here. */
export function readDirectoryStanding(
  entry: DirectoryEntry | null,
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
  directory: WorkspaceDirectory,
  email: string,
): Promise<DirectoryStanding> {
  try {
    return readDirectoryStanding(await directory.getPerson(email));
  } catch (error) {
    // A provider's own messages can echo what was sent; a DirectoryError's
    // carries the status only.
    return {
      error:
        error instanceof DirectoryError
          ? error.message
          : "The directory could not be asked.",
      state: "unknown",
    };
  }
}

/** Whether offboarding is on (Settings, or WORKSPACE_OFFBOARDING=on). */
export function isOffboardingEnabled(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): boolean {
  return (
    resolveWorkspaceSetting("directory.offboarding", stored, env)
      .value?.trim()
      .toLowerCase() === "on"
  );
}

/** "acme.com, @Acme.example" as ["acme.com", "acme.example"]; null if any is not a domain. */
export function parseDomainList(value: string): string[] | null {
  const domains: string[] = [];

  for (const part of value.split(/[\s,;]+/)) {
    if (!part) {
      continue;
    }

    const domain = normalizeEmailDomain(part);

    if (!domain) {
      return null;
    }

    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }

  return domains;
}

/**
 * The organization's domains: the ones set for the directory, or else the
 * domains the sign-up rule allows. None means nobody is asked about.
 */
export function resolveOrganizationDomains(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
  signupDomains: readonly string[] = [],
): string[] {
  const setting = resolveWorkspaceSetting("directory.domains", stored, env);

  if (setting.value) {
    return parseDomainList(setting.value) ?? [];
  }

  return parseDomainList(signupDomains.join(",")) ?? [];
}

/** Whether the address is in one of the organization's domains. */
export function isOrganizationAddress(
  email: string,
  domains: readonly string[],
): boolean {
  const domain = getEmailDomain(email);

  return domain !== null && domains.includes(domain);
}

/**
 * The most accounts one run may offboard: WORKSPACE_OFFBOARDING_MAX_PER_RUN,
 * kept between 1 and 500, or 10.
 */
export function resolveMaxPerRun(env: EnvSource = process.env): number {
  const raw = readEnv(env, "WORKSPACE_OFFBOARDING_MAX_PER_RUN");
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;

  return Number.isFinite(parsed)
    ? Math.min(MAX_PER_RUN_LIMIT, Math.max(1, parsed))
    : DEFAULT_MAX_PER_RUN;
}

/**
 * The break-glass addresses: the ones kept to sign in with a password when
 * password sign-in is off (PASSWORD_SIGN_IN_ALLOWED_EMAILS), whether or not
 * it is off right now. An address someone set aside for emergencies is
 * never offboarded by a job.
 */
export function collectBreakGlassAddresses(
  env: EnvSource = process.env,
): Set<string> {
  return new Set([
    ...readPasswordSignInPolicy(env).allowedEmails,
    ...(readEnv(env, "PASSWORD_SIGN_IN_ALLOWED_EMAILS") ?? "")
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
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
  /** Drafts, envelopes out for signature, and records handed over to it. */
  openEnvelopes: number;
  role: "admin" | "user";
};

export type AccountPlan =
  | { kind: "nothing" }
  | {
      kind: "offboard";
      managerEmail: string | null;
      reason: OffboardingReason;
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
    // when nothing else works is what the address is for.
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
  toEmail: string;
  toUserId: string;
};

export type OffboardingAccountResult = {
  email: string;
  userId: string;
} & (
  | {
      action: "offboarded";
      /** False when the account was already blocked by an earlier run. */
      blocked: boolean;
      envelopes: HandedOverEnvelope[];
      /**
       * Envelopes nobody could take: no manager and no administrator, or
       * waiting for a manager who could not be looked up.
       */
      envelopesKept: number;
      reason: OffboardingReason;
      sessionsEnded: number;
    }
  | { action: "restored"; why: "break_glass" | "directory_active" }
  | { action: "deferred"; reason: OffboardingReason }
  | {
      action: "skipped";
      error?: string;
      reason?: OffboardingReason;
      why: "break_glass" | "last_admin" | "lookup_failed" | "missing";
    }
);

export type OffboardingCounts = {
  blocked: number;
  checked: number;
  deferred: number;
  envelopesHandedOver: number;
  lookupFailures: number;
  skipped: number;
  unblocked: number;
};

export type OffboardingRun = {
  /** Accounts changed or skipped. Not the quiet ones. */
  accounts: OffboardingAccountResult[];
  counts: OffboardingCounts;
  maxPerRun: number;
  /** More accounts are in the domains than one run asks about. */
  moreToCheck: boolean;
  ranAt: number;
  status: "ran";
  /** Too many lookups failed, so nothing was changed. */
  stoppedEarly: boolean;
};

export type OffboardingOutcome =
  | { reason: "no_directory" | "off"; status: "not_configured" }
  | { status: "no_domains" }
  | { status: "already_running" }
  | OffboardingRun;

/**
 * The HTTP status a scheduler should see: offboarding that is turned on
 * but cannot run, or that stopped because the directory failed, shows as
 * failed there.
 */
export function offboardingHttpStatus(outcome: OffboardingOutcome): number {
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

export type RunOffboardingOptions = {
  database?: DbPool;
  /** Replaced in tests. Null means no directory is set up. */
  directory?: WorkspaceDirectory | null;
  env?: EnvSource;
  now?: () => number;
  /** The provider's id, for the audit trail. */
  provider?: string;
  /** The sign-up rule's domains. Read from the settings when not given. */
  signupDomains?: readonly string[];
  /** The stored workspace settings. Read when not given. */
  stored?: WorkspaceSettings;
};

/**
 * One run. Never two at once: a second run while one is going answers
 * already_running.
 */
export async function runOffboarding(
  options: RunOffboardingOptions = {},
): Promise<OffboardingOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const context =
    options.stored === undefined || options.directory === undefined
      ? await getWorkspaceContext(env)
      : null;
  const stored = options.stored ?? context?.settings ?? {};

  if (!isOffboardingEnabled(stored, env)) {
    return { reason: "off", status: "not_configured" };
  }

  let directory = options.directory;
  let provider = options.provider ?? "directory";

  if (directory === undefined) {
    const chosen = resolveCapabilityProvider("directory", stored, env).provider;

    directory = chosen?.directory?.({ env, settings: stored }) ?? null;
    provider = chosen?.id ?? provider;
  }

  if (!directory) {
    return { reason: "no_directory", status: "not_configured" };
  }

  let signupDomains = options.signupDomains;

  if (
    signupDomains === undefined &&
    !resolveWorkspaceSetting("directory.domains", stored, env).value
  ) {
    const settings = await readStoredSettings(options.database ?? getDb());

    signupDomains =
      settings?.signupMode === "domains" ? settings.allowedEmailDomains : [];
  }

  const domains = resolveOrganizationDomains(stored, env, signupDomains);

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
      [OFFBOARDING_ADVISORY_LOCK_ID],
    );

    if (!lock.rows[0]?.locked) {
      return { status: "already_running" };
    }

    const run = await syncAccounts({
      breakGlass: collectBreakGlassAddresses(env),
      database,
      directory,
      domains,
      maxPerRun: resolveMaxPerRun(env),
      now: now(),
      provider,
    });

    await recordLastRun(run, database);

    return run;
  } finally {
    await lockClient.query("rollback").catch(() => undefined);
    lockClient.release();
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
          WHERE e.user_id = u.id
            AND (e.status = ANY($3::text[]) OR e.handed_over_at IS NOT NULL)
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
 * blocked and not being closed. Their row is held so they cannot be
 * blocked or closed until the envelopes have moved.
 */
async function lockUsableManager(
  tx: DbExecutor,
  managerEmail: string,
  fromUserId: string,
): Promise<Recipient | null> {
  return queryOne<Recipient>(
    tx,
    `
      SELECT u.id, u.email
      FROM "user" u
      WHERE lower(u.email) = $1
        AND u.id <> $2
        AND u.directory_blocked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
        )
      ORDER BY u.id
      LIMIT 1
      FOR SHARE OF u
    `,
    [managerEmail.trim().toLowerCase(), fromUserId],
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
  fromUserId: string,
): Promise<Recipient | null> {
  for (let attempt = 0; attempt < MAX_KEEPER_ATTEMPTS; attempt += 1) {
    const keeperId = await findRecordKeeper(fromUserId, tx);

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
  /** The manager, when the directory says they are still active. */
  managerEmail: string | null;
  /** The manager could not be looked up: their work waits for a later run. */
  managerUnknown: boolean;
  now: number;
  provider: string;
  reason: OffboardingReason;
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

  // The last administrator who can still sign in is never blocked, so the
  // site is never left with nobody to run it.
  if (current.role === "admin" && !(await findRecordKeeper(account.id, tx))) {
    return { done: false, why: "last_admin" };
  }

  // The lock an UPDATE takes, as signing, voiding and reminders take it:
  // each of those that got in first has finished, and one that comes after
  // waits and then finds the envelope with its new owner. Not FOR UPDATE: a
  // signer's audit event needs a share of this row for its foreign key, and
  // would wait behind it.
  const open = await queryMany<{ handedOverAt: number | null; id: string }>(
    tx,
    `
      SELECT id, handed_over_at AS "handedOverAt"
      FROM envelopes
      WHERE user_id = $1
        AND (status = ANY($2::text[]) OR handed_over_at IS NOT NULL)
      ORDER BY id
      FOR NO KEY UPDATE
    `,
    [account.id, OPEN_STATUSES],
  );

  const forManager = (envelope: { handedOverAt: number | null }) =>
    envelope.handedOverAt === null;
  const manager =
    input.managerEmail && open.some(forManager)
      ? await lockUsableManager(tx, input.managerEmail, account.id)
      : null;
  // Work that would go to a manager nobody could look up stays where it is
  // for now, not with an administrator.
  const waitsForManager = (envelope: { handedOverAt: number | null }) =>
    forManager(envelope) && !manager && input.managerUnknown;
  const needsKeeper = open.some(
    (envelope) =>
      !forManager(envelope) || (!manager && !waitsForManager(envelope)),
  );
  const keeper = needsKeeper ? await lockKeeper(tx, account.id) : null;
  const handedOver: HandedOverEnvelope[] = [];
  let envelopesKept = 0;

  for (const envelope of open) {
    const toManager = forManager(envelope) && manager !== null;
    const recipient = toManager ? manager : keeper;

    if (waitsForManager(envelope) || !recipient) {
      envelopesKept += 1;
      continue;
    }

    // To an administrator it is marked as handed over, as a closed
    // account's records are; to a manager it becomes their own.
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
    handedOver.push({
      envelopeId: envelope.id,
      handedTo: toManager ? "manager" : "administrator",
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
    // once.
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
          source: input.provider,
          targetEmail: current.email,
          targetName: current.name,
        },
        targetUserId: account.id,
      },
      tx,
    );
  }

  // One line per person who took something, naming every envelope.
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
          handedTo: first.handedTo,
          reason,
          source: input.provider,
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
  provider: string,
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
      event: "directory_sign_in_unblocked",
      metadata: {
        blockedAt: current.blockedAt,
        previousReason: current.blockedReason,
        source: provider,
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

function emptyCounts(): OffboardingCounts {
  return {
    blocked: 0,
    checked: 0,
    deferred: 0,
    envelopesHandedOver: 0,
    lookupFailures: 0,
    skipped: 0,
    unblocked: 0,
  };
}

async function syncAccounts({
  breakGlass,
  database,
  directory,
  domains,
  maxPerRun,
  now,
  provider,
}: {
  breakGlass: ReadonlySet<string>;
  database: DbPool;
  directory: WorkspaceDirectory;
  domains: readonly string[];
  maxPerRun: number;
  now: number;
  provider: string;
}): Promise<OffboardingRun> {
  const { accounts, total } = await listAccountsToCheck(domains, database);
  const counts = emptyCounts();
  const results: OffboardingAccountResult[] = [];
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

  const finish = (): OffboardingRun => ({
    accounts: results,
    counts,
    maxPerRun,
    moreToCheck: total > looked.length,
    ranAt: now,
    status: "ran",
    stoppedEarly,
  });

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

    return finish();
  }

  // A manager who has left too is no one to hand work to. Their answer is
  // usually in already; otherwise they are asked once. A manager who could
  // not be looked up is not known to be gone: the work waits for the next
  // run instead of going to an administrator.
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

  // Skipped for want of an answer about their manager: asked again first.
  const lookupFailedIds = new Set<string>();
  let used = 0;

  for (const { account, standing } of looked) {
    const plan = planAccount(account, standing, breakGlass);

    switch (plan.kind) {
      case "nothing":
        break;
      case "skip":
        results.push(
          plan.why === "lookup_failed"
            ? {
                action: "skipped",
                email: account.email,
                error: plan.error,
                userId: account.id,
                why: "lookup_failed",
              }
            : {
                action: "skipped",
                email: account.email,
                userId: account.id,
                why: "break_glass",
              },
        );
        break;
      case "restore": {
        const restored = await withTransaction(
          (tx) => restoreAccount(tx, account.id, plan.why, now, provider),
          database,
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

        const outcome = await withTransaction(
          (tx) =>
            offboardAccount(tx, {
              account,
              breakGlass,
              managerEmail: "email" in manager ? manager.email : null,
              managerUnknown,
              now,
              provider,
              reason: plan.reason,
            }),
          database,
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
        counts.blocked += result.blocked ? 1 : 0;
        counts.envelopesHandedOver += result.envelopes.length;
        break;
      case "restored":
        counts.unblocked += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
    }
  }

  // Answered, so the next run starts with the ones asked about longest
  // ago. A failed lookup is not marked, so it is asked again first, and nor
  // is an account left for later by the cap.
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

  return finish();
}

export type OffboardingLastRun = {
  counts: OffboardingCounts;
  moreToCheck: boolean;
  ranAt: number;
  stoppedEarly: boolean;
};

/** Keeps the run's summary for Settings, replacing the one before. */
async function recordLastRun(run: OffboardingRun, database: DbExecutor) {
  const summary = {
    counts: run.counts,
    moreToCheck: run.moreToCheck,
    stoppedEarly: run.stoppedEarly,
  };

  await database.query(
    `
      INSERT INTO directory_sync_last_run (id, ran_at, summary)
      VALUES (1, $1, $2)
      ON CONFLICT (id) DO UPDATE
      SET ran_at = EXCLUDED.ran_at, summary = EXCLUDED.summary
    `,
    [run.ranAt, JSON.stringify(summary)],
  );
}

/** The last run, or null when there has been none. */
export async function readLastOffboardingRun(
  database: DbExecutor = getDb(),
): Promise<OffboardingLastRun | null> {
  try {
    const row = await queryOne<{
      ranAt: string | number;
      summary: Omit<OffboardingLastRun, "ranAt">;
    }>(
      database,
      `SELECT ran_at AS "ranAt", summary FROM directory_sync_last_run WHERE id = 1`,
    );

    return row ? { ...row.summary, ranAt: Number(row.ranAt) } : null;
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null;
    }

    throw error;
  }
}
