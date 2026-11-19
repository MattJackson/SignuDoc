import { createHash } from "node:crypto";

import { waitUntil } from "@vercel/functions";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
} from "../db/connection.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import type { EnvSource } from "../utils/env.ts";
import { getWorkspaceFiles } from "./registry.ts";
import {
  getWorkspaceSettings,
  resolveWorkspaceSetting,
  type WorkspaceSettings,
} from "./settings.ts";
import {
  ExportError,
  type ExecutedCopy,
  type ExportMetadata,
  type ExportResult,
  type WorkspaceFiles,
} from "./types.ts";

// Copies of completed envelopes in the workspace: when an envelope is
// completed, its sealed PDF and its audit certificate are put in the shared
// location an administrator chose (a Shared Drive for Google), in folders
// laid out by a pattern, by the provider's WorkspaceFiles.
//
// It is an outbox (workspace_exports). The row is written in the same
// transaction that completes the envelope (signing.ts), so a completion is
// never missed even if the provider is down, and a completion never fails
// because of it. Right after the commit the copy is tried once;
// /api/internal/workspace-export tries again what is due, waiting longer
// after each failure, and gives up after MAX_EXPORT_ATTEMPTS until an
// administrator retries it.
//
// Each claim of a row sets locked_until, and every later update names that
// value, so a worker whose claim lapsed and was taken over changes nothing.

export const MAX_EXPORT_ATTEMPTS = 8;
const BASE_DELAY_SECONDS = 5 * 60;
const MAX_DELAY_SECONDS = 12 * 60 * 60;
// A claimed row is left alone by other runs for this long.
const CLAIM_SECONDS = 10 * 60;
const MAX_ERROR_LENGTH = 500;

export type WorkspaceExportStatus = "exported" | "failed" | "pending";

// --- Folder layout ------------------------------------------------------

export const DEFAULT_EXPORT_FOLDER_PATTERN =
  "{yyyy}/{yyyy-MM-dd} — {title} — {shortId}";

const MAX_SEGMENT_LENGTH = 200;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Where an executed copy goes: the folder names, then the file's own name
 * (without .pdf) last. Dates are in UTC. A slash in a value (a title, say)
 * does not make a folder; it becomes a dash.
 *
 * Tokens: {yyyy} {MM} {dd} {yyyy-MM} {yyyy-MM-dd} {title} {shortId}
 * {envelopeId} {senderEmail}. Anything else is kept as written.
 */
export function renderExportPath(
  pattern: string,
  values: {
    completedAt: number;
    envelopeId: string;
    senderEmail?: string | null;
    title: string;
  },
): string[] {
  const date = new Date(values.completedAt * 1000);
  const yyyy = String(date.getUTCFullYear());
  const MM = twoDigits(date.getUTCMonth() + 1);
  const dd = twoDigits(date.getUTCDate());
  const clean = (value: string) => value.replace(/[/\\]+/g, "-").trim();
  const tokens: Record<string, string> = {
    MM,
    dd,
    envelopeId: values.envelopeId,
    senderEmail: clean(values.senderEmail ?? ""),
    shortId: values.envelopeId.replace(/-/g, "").slice(0, 8),
    title: clean(values.title),
    yyyy,
    "yyyy-MM": `${yyyy}-${MM}`,
    "yyyy-MM-dd": `${yyyy}-${MM}-${dd}`,
  };
  const segments = (pattern.trim() || DEFAULT_EXPORT_FOLDER_PATTERN)
    .split("/")
    .map((segment) =>
      segment
        .replace(/\{([A-Za-z-]+)\}/g, (whole, name: string) =>
          Object.hasOwn(tokens, name) ? (tokens[name] ?? "") : whole,
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_SEGMENT_LENGTH)
        .trim(),
    )
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

  return segments.length > 0
    ? segments
    : [clean(values.title) || values.envelopeId];
}

/** Why a pattern cannot be used, or null when it can. */
export function validateFolderPattern(pattern: string): string | null {
  if (pattern.length > 300) {
    return "Keep the layout under 300 characters.";
  }

  if (pattern.trim().endsWith("/")) {
    return "The last part is the file's name, so the layout cannot end with a slash.";
  }

  return null;
}

/** Where an envelope completed now would go, as an example for Settings. */
export function previewExportPath(pattern: string): string {
  return `${renderExportPath(pattern, {
    completedAt: Math.floor(Date.now() / 1000),
    envelopeId: "3f2a9c1e-0000-4000-8000-000000000000",
    senderEmail: "sender@example.com",
    title: "Services agreement",
  }).join("/")}.pdf`;
}

// --- Metadata -----------------------------------------------------------

export type SignerForCounterparty = {
  email: string;
  name: string | null;
  role: string;
};

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The counterparty: the first signer, in signing order, whose address is
 * outside the sender's own domain.
 */
export function findCounterparty(
  signers: readonly SignerForCounterparty[],
  senderEmail: string,
): { email: string; name: string | null } | null {
  const inside = domainOf(senderEmail);
  const signer = signers.find(
    (item) => item.role === "signer" && domainOf(item.email) !== inside,
  );

  return signer ? { email: signer.email, name: signer.name } : null;
}

/** The facts a provider may attach to the copy (types.ts). */
export function buildExportMetadata(input: {
  completedAt: number;
  counterparty: { email: string; name: string | null } | null;
  envelopeId: string;
  senderEmail: string;
  senderName: string | null;
  title: string;
}): ExportMetadata {
  return {
    completedDate: new Date(input.completedAt * 1000)
      .toISOString()
      .slice(0, 10),
    counterparty: input.counterparty
      ? input.counterparty.name?.trim() || input.counterparty.email
      : null,
    counterpartyEmail: input.counterparty?.email ?? null,
    envelopeId: input.envelopeId,
    senderEmail: input.senderEmail,
    senderName: input.senderName?.trim() || null,
    title: input.title,
  };
}

// --- Retries ------------------------------------------------------------

/** How long to wait before the next try, after this many have failed. */
export function nextAttemptDelaySeconds(failedAttempts: number): number {
  const exponent = Math.max(0, failedAttempts - 1);

  return Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** exponent);
}

/** What a failed try leaves the row as. */
export function afterFailedAttempt(
  attempts: number,
  nowSeconds: number,
  permanent = false,
): { nextAttemptAt: number; status: WorkspaceExportStatus } {
  if (permanent || attempts >= MAX_EXPORT_ATTEMPTS) {
    return { nextAttemptAt: nowSeconds, status: "failed" };
  }

  return {
    nextAttemptAt: nowSeconds + nextAttemptDelaySeconds(attempts),
    status: "pending",
  };
}

// --- The outbox ---------------------------------------------------------

/**
 * Where executed copies go, or null when they are not exported: no
 * provider, or no destination. Never throws: the completion it is read
 * for must not fail because of it.
 */
export async function readExportDestination(
  env: EnvSource = process.env,
): Promise<string | null> {
  try {
    if (!(await getWorkspaceFiles(env))) {
      return null;
    }

    return resolveWorkspaceSetting(
      "files.exportDestination",
      await getWorkspaceSettings(),
      env,
    ).value;
  } catch (error) {
    console.warn(
      "[workspace] Could not read the export destination; this completion is not copied:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Adds the outbox row. Called inside the completion's transaction. */
export async function enqueueWorkspaceExport(
  database: DbExecutor,
  input: { destination: string; envelopeId: string; nowSeconds: number },
): Promise<void> {
  await database.query(
    `
      INSERT INTO workspace_exports (
        envelope_id, destination, status, attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES ($1, $2, 'pending', 0, $3, $3, $3)
      ON CONFLICT (envelope_id) DO NOTHING
    `,
    [input.envelopeId, input.destination, input.nowSeconds],
  );
}

export type WorkspaceExportRow = {
  attempts: number;
  destination: string;
  envelopeId: string;
  /** The locked_until this claim set; every later update names it. */
  lease: number;
};

const RETURNING = `envelope_id AS "envelopeId", destination, attempts, locked_until AS "lease"`;

/** Takes up to `limit` rows that are due, marking them as being tried. */
export async function claimDueWorkspaceExports(
  database: DbExecutor,
  { limit, nowSeconds }: { limit: number; nowSeconds: number },
): Promise<WorkspaceExportRow[]> {
  return queryMany<WorkspaceExportRow>(
    database,
    `
      UPDATE workspace_exports
      SET attempts = attempts + 1, locked_until = $1::bigint + $3::bigint, updated_at = $1
      WHERE envelope_id IN (
        SELECT envelope_id FROM workspace_exports
        WHERE status = 'pending'
          AND next_attempt_at <= $1
          AND (locked_until IS NULL OR locked_until < $1)
        ORDER BY next_attempt_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${RETURNING}
    `,
    [nowSeconds, limit, CLAIM_SECONDS],
  );
}

/** Takes one envelope's row if it is waiting and nobody is trying it. */
export async function claimWorkspaceExport(
  database: DbExecutor,
  envelopeId: string,
  nowSeconds: number,
): Promise<WorkspaceExportRow | null> {
  return queryOne<WorkspaceExportRow>(
    database,
    `
      UPDATE workspace_exports
      SET attempts = attempts + 1, locked_until = $2::bigint + $3::bigint, updated_at = $2
      WHERE envelope_id = $1
        AND status = 'pending'
        AND (locked_until IS NULL OR locked_until < $2)
      RETURNING ${RETURNING}
    `,
    [envelopeId, nowSeconds, CLAIM_SECONDS],
  );
}

export function describeExportError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The copy could not be made.";

  return message.slice(0, MAX_ERROR_LENGTH);
}

export type WorkspaceExportDeps = {
  database: DbPool;
  env: EnvSource;
  /** The provider's files, or null when no provider is chosen. */
  files: () => Promise<WorkspaceFiles | null>;
  /** Milliseconds. */
  now: () => number;
  /** The stored workspace settings (the folder pattern). */
  settings: () => Promise<WorkspaceSettings | null>;
  storageService: StorageService;
};

function defaultDeps(
  partial: Partial<WorkspaceExportDeps> = {},
): WorkspaceExportDeps {
  const env = partial.env ?? process.env;

  return {
    database: partial.database ?? getDb(),
    env,
    files: partial.files ?? (() => getWorkspaceFiles(env)),
    now: partial.now ?? Date.now,
    settings: partial.settings ?? (() => getWorkspaceSettings()),
    storageService: partial.storageService ?? createStorageService(),
  };
}

type EnvelopeForExport = {
  completedAt: number | null;
  evidenceKey: string | null;
  id: string;
  senderEmail: string;
  senderName: string | null;
  signedPdfKey: string | null;
  status: string;
  title: string;
};

async function loadEnvelope(
  database: DbExecutor,
  envelopeId: string,
): Promise<EnvelopeForExport | null> {
  return queryOne<EnvelopeForExport>(
    database,
    `
      SELECT
        e.id,
        e.title,
        e.status,
        e.completed_at AS "completedAt",
        e.signed_pdf_key AS "signedPdfKey",
        e.evidence_key AS "evidenceKey",
        u.email AS "senderEmail",
        u.name AS "senderName"
      FROM envelopes e
      JOIN public."user" u ON u.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId],
  );
}

async function loadMetadata(
  database: DbExecutor,
  envelope: EnvelopeForExport,
): Promise<ExportMetadata> {
  const signers = await queryMany<SignerForCounterparty>(
    database,
    `
      SELECT email, name, role FROM signers
      WHERE envelope_id = $1
      ORDER BY sign_order, created_at
    `,
    [envelope.id],
  );

  return buildExportMetadata({
    completedAt: envelope.completedAt ?? 0,
    counterparty: findCounterparty(signers, envelope.senderEmail),
    envelopeId: envelope.id,
    senderEmail: envelope.senderEmail,
    senderName: envelope.senderName,
    title: envelope.title,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One try at one claimed row. Records the outcome on the row. */
export async function exportClaimedRow(
  row: WorkspaceExportRow,
  partialDeps: Partial<WorkspaceExportDeps> = {},
): Promise<WorkspaceExportStatus> {
  const deps = defaultDeps(partialDeps);
  const nowSeconds = () => Math.floor(deps.now() / 1000);

  try {
    const envelope = await loadEnvelope(deps.database, row.envelopeId);

    if (
      !envelope ||
      envelope.status !== "completed" ||
      !envelope.signedPdfKey ||
      !envelope.evidenceKey ||
      !envelope.completedAt
    ) {
      throw new ExportError(
        "The envelope is no longer completed with its files, so there is nothing to copy.",
        true,
      );
    }

    const files = await deps.files();

    if (!files) {
      throw new ExportError(
        "No workspace provider is chosen, so the copy cannot be made.",
      );
    }

    const pattern =
      resolveWorkspaceSetting(
        "files.exportFolderPattern",
        await deps.settings(),
        deps.env,
      ).value ?? DEFAULT_EXPORT_FOLDER_PATTERN;
    const path = renderExportPath(pattern, {
      completedAt: envelope.completedAt,
      envelopeId: envelope.id,
      senderEmail: envelope.senderEmail,
      title: envelope.title,
    });
    const baseName = path[path.length - 1] ?? envelope.id;
    const [signed, certificate, metadata] = await Promise.all([
      deps.storageService.getObject(envelope.signedPdfKey),
      deps.storageService.getObject(envelope.evidenceKey),
      loadMetadata(deps.database, envelope),
    ]);
    const copies: ExecutedCopy[] = [
      {
        bytes: signed.body,
        fileName: `${baseName}.pdf`,
        kind: "signed",
        sha256: sha256(signed.body),
      },
      {
        bytes: certificate.body,
        fileName: `${baseName} — certificate.pdf`,
        kind: "certificate",
        sha256: sha256(certificate.body),
      },
    ];
    const result: ExportResult = await files.exportExecutedCopies({
      copies,
      destination: row.destination,
      envelopeId: envelope.id,
      folderPath: path.slice(0, -1),
      metadata,
    });

    await deps.database.query(
      `
        UPDATE workspace_exports
        SET
          status = 'exported',
          exported_at = $2,
          updated_at = $2,
          locked_until = NULL,
          last_error = NULL,
          exported_files = $3::jsonb,
          metadata_problem = $4
        WHERE envelope_id = $1 AND locked_until = $5
      `,
      [
        row.envelopeId,
        nowSeconds(),
        JSON.stringify(result.files),
        result.metadataProblem?.slice(0, MAX_ERROR_LENGTH) ?? null,
        row.lease,
      ],
    );

    return "exported";
  } catch (error) {
    const permanent = error instanceof ExportError && error.permanent;
    const outcome = afterFailedAttempt(row.attempts, nowSeconds(), permanent);

    if (!(error instanceof ExportError)) {
      console.warn(
        `[workspace] Copying envelope ${row.envelopeId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }

    await deps.database.query(
      `
        UPDATE workspace_exports
        SET
          status = $2,
          next_attempt_at = $3,
          last_error = $4,
          locked_until = NULL,
          updated_at = $5
        WHERE envelope_id = $1 AND locked_until = $6
      `,
      [
        row.envelopeId,
        outcome.status,
        outcome.nextAttemptAt,
        describeExportError(error),
        nowSeconds(),
        row.lease,
      ],
    );

    return outcome.status;
  }
}

/** Tries one envelope now, if its row is waiting. */
export async function runWorkspaceExportNow(
  envelopeId: string,
  partialDeps: Partial<WorkspaceExportDeps> = {},
): Promise<WorkspaceExportStatus | null> {
  const deps = defaultDeps(partialDeps);
  const row = await claimWorkspaceExport(
    deps.database,
    envelopeId,
    Math.floor(deps.now() / 1000),
  );

  return row ? exportClaimedRow(row, deps) : null;
}

export type WorkspaceExportRunSummary = {
  exported: number;
  failed: number;
  retrying: number;
  tried: number;
};

/** Tries what is due, one at a time, until the deadline or none are left. */
export async function runDueWorkspaceExports({
  batchSize = 10,
  deadline,
  deps: partialDeps = {},
}: {
  batchSize?: number;
  /** Milliseconds: no new try starts after this. */
  deadline: number;
  deps?: Partial<WorkspaceExportDeps>;
}): Promise<WorkspaceExportRunSummary> {
  const deps = defaultDeps(partialDeps);
  const summary: WorkspaceExportRunSummary = {
    exported: 0,
    failed: 0,
    retrying: 0,
    tried: 0,
  };

  while (deps.now() < deadline) {
    const rows = await claimDueWorkspaceExports(deps.database, {
      limit: batchSize,
      nowSeconds: Math.floor(deps.now() / 1000),
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      if (deps.now() >= deadline) {
        // Not tried: handed back for the next run, without the try counted.
        await deps.database.query(
          `
            UPDATE workspace_exports
            SET attempts = attempts - 1, locked_until = NULL
            WHERE envelope_id = $1 AND locked_until = $2
          `,
          [row.envelopeId, row.lease],
        );
        continue;
      }

      const status = await exportClaimedRow(row, deps);

      summary.tried += 1;
      summary[status === "pending" ? "retrying" : status] += 1;
    }
  }

  return summary;
}

declare global {
  var __signudocWorkspaceExportsInFlight: Set<Promise<unknown>> | undefined;
}

function inFlight(): Set<Promise<unknown>> {
  globalThis.__signudocWorkspaceExportsInFlight ??= new Set();

  return globalThis.__signudocWorkspaceExportsInFlight;
}

/**
 * Tries the envelope's copy after the completion has committed, without
 * holding up the signer. On Vercel the function is kept alive for it.
 */
export function scheduleWorkspaceExport(
  envelopeId: string,
  partialDeps: Partial<WorkspaceExportDeps> = {},
): void {
  const task = runWorkspaceExportNow(envelopeId, partialDeps).catch(
    (error: unknown) => {
      console.warn(
        `[workspace] The first copy of envelope ${envelopeId} could not run; the retry job will try again:`,
        error instanceof Error ? error.message : error,
      );
    },
  );
  const tasks = inFlight();

  tasks.add(task);
  void task.finally(() => tasks.delete(task));

  try {
    waitUntil(task);
  } catch {
    // Not on Vercel: the promise runs on its own.
  }
}

/** Waits for copies started by scheduleWorkspaceExport, for tests. */
export async function settleScheduledWorkspaceExports(): Promise<void> {
  await Promise.all(Array.from(inFlight()));
}

// --- For the administrator ----------------------------------------------

export type WorkspaceExportListItem = {
  attempts: number;
  completedAt: number | null;
  createdAt: number;
  envelopeId: string;
  exportedAt: number | null;
  files: ExportResult["files"] | null;
  lastError: string | null;
  metadataProblem: string | null;
  nextAttemptAt: number;
  status: WorkspaceExportStatus;
  title: string;
};

/** The latest copies, failed first, then newest first. */
export async function listWorkspaceExports(
  database: DbExecutor = getDb(),
  {
    limit = 25,
    status,
  }: { limit?: number; status?: WorkspaceExportStatus } = {},
): Promise<WorkspaceExportListItem[]> {
  return queryMany<WorkspaceExportListItem>(
    database,
    `
      SELECT
        x.envelope_id AS "envelopeId",
        e.title,
        e.completed_at AS "completedAt",
        x.status,
        x.attempts,
        x.next_attempt_at AS "nextAttemptAt",
        x.last_error AS "lastError",
        x.metadata_problem AS "metadataProblem",
        x.exported_files AS "files",
        x.created_at AS "createdAt",
        x.exported_at AS "exportedAt"
      FROM workspace_exports x
      JOIN envelopes e ON e.id = x.envelope_id
      WHERE ($2::text IS NULL OR x.status = $2)
      ORDER BY
        CASE x.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        x.created_at DESC
      LIMIT $1
    `,
    [Math.max(1, Math.min(limit, 100)), status ?? null],
  );
}

/**
 * Puts a copy back in line now, with its tries counted from zero, and
 * reports whether there was one to retry. One already made is tried again
 * too: the provider finds its files and only attaches the metadata again.
 * One that is being tried right now is left alone (null), so two tries of
 * the same envelope never run together.
 */
export async function requeueWorkspaceExport(
  database: DbExecutor,
  envelopeId: string,
  nowSeconds: number,
): Promise<{ title: string } | null> {
  return queryOne<{ title: string }>(
    database,
    `
      UPDATE workspace_exports x
      SET
        status = 'pending',
        attempts = 0,
        next_attempt_at = $2,
        locked_until = NULL,
        updated_at = $2
      FROM envelopes e
      WHERE x.envelope_id = $1 AND e.id = x.envelope_id
        AND (x.locked_until IS NULL OR x.locked_until < $2)
      RETURNING e.title
    `,
    [envelopeId, nowSeconds],
  );
}

export type RetryResult =
  | { message: string; ok: false }
  | { ok: true; status: WorkspaceExportStatus | null };

/** Puts a copy back in line, records it, and tries it at once. */
export async function retryWorkspaceExport(
  envelopeId: string,
  actor: {
    email: string;
    id: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  partialDeps: Partial<WorkspaceExportDeps> = {},
): Promise<RetryResult> {
  const deps = defaultDeps(partialDeps);
  const requeued = await requeueWorkspaceExport(
    deps.database,
    envelopeId,
    Math.floor(deps.now() / 1000),
  );

  if (!requeued) {
    const existing = await queryOne<{ envelopeId: string }>(
      deps.database,
      `SELECT envelope_id AS "envelopeId" FROM workspace_exports WHERE envelope_id = $1`,
      [envelopeId],
    );

    return {
      message: existing
        ? "This copy is being made right now."
        : "There is no copy for this envelope.",
      ok: false,
    };
  }

  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event: "workspace_export_retried",
      ipAddress: actor.ipAddress ?? null,
      metadata: { envelopeId, title: requeued.title },
      userAgent: actor.userAgent ?? null,
    },
    deps.database,
  );

  return { ok: true, status: await runWorkspaceExportNow(envelopeId, deps) };
}
