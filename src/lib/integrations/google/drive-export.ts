import { createHash } from "node:crypto";

import { waitUntil } from "@vercel/functions";

import { resolveWorkspaceDomains } from "../../auth/sso.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
} from "../../db/connection.ts";
import { getIntegrationSettings } from "../../integration-settings.ts";
import {
  createStorageService,
  type StorageService,
} from "../../services/storage.ts";
import { getSettings } from "../../settings.ts";
import type { EnvSource } from "../../utils/env.ts";
import {
  getGoogleCredentials,
  GOOGLE_SCOPES,
  type GoogleAccessTokenRequest,
} from "./credentials.ts";
import {
  DRIVE_API_BASE_URL,
  DriveApiError,
  driveJson,
  GOOGLE_FOLDER_MIME_TYPE,
  quoteDriveQuery,
  uploadDriveFile,
  type FetchLike,
} from "./drive-api.ts";
import {
  readDriveExportConfig,
  readDriveLabelConfig,
  renderDrivePath,
  type DriveLabelConfig,
} from "./drive-config.ts";
import {
  applyDriveLabel,
  buildLabelModification,
  buildLabelValues,
  findCounterparty,
  getDriveLabel,
  type LabelValues,
} from "./drive-labels.ts";

// Executed copies in a Shared Drive: when an envelope is completed, its
// sealed PDF and its audit certificate are put in a Shared Drive the
// administrator chose, by the app's service account (credentials.ts), in a
// folder layout of their choosing.
//
// It is an outbox (drive_exports). The row is written in the same
// transaction that completes the envelope (signing.ts), so a completion is
// never missed even if Google is down. Right after the commit the upload is
// tried once; /api/internal/drive-export tries again what is due, waiting
// longer after each failure, and gives up after MAX_DRIVE_EXPORT_ATTEMPTS
// until an administrator retries it.
//
// A retry never makes a second copy: each uploaded file carries
// appProperties with the envelope's id and the file's SHA-256, and the
// Shared Drive is searched for them before uploading. Every call passes
// supportsAllDrives=true.
//
// A label (drive-labels.ts) is put on the signed PDF after the upload when
// one is set up. A label that cannot be applied is recorded on the row; the
// export itself still counts as done.

export const MAX_DRIVE_EXPORT_ATTEMPTS = 8;
const BASE_DELAY_SECONDS = 5 * 60;
const MAX_DELAY_SECONDS = 12 * 60 * 60;
// A claimed row is left alone by other runs for this long.
const CLAIM_SECONDS = 10 * 60;
const MAX_ERROR_LENGTH = 500;

const APP_PROPERTY_ENVELOPE = "signudocEnvelopeId";
const APP_PROPERTY_SHA256 = "signudocSha256";
const APP_PROPERTY_KIND = "signudocKind";

export type DriveExportStatus = "exported" | "failed" | "pending";

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
): { nextAttemptAt: number; status: DriveExportStatus } {
  if (permanent || attempts >= MAX_DRIVE_EXPORT_ATTEMPTS) {
    return { nextAttemptAt: nowSeconds, status: "failed" };
  }

  return {
    nextAttemptAt: nowSeconds + nextAttemptDelaySeconds(attempts),
    status: "pending",
  };
}

/**
 * The Shared Drive executed copies go to, or null when the export is off.
 * Never throws: the completion it is read for must not fail because of it.
 */
export async function readDriveExportTarget(
  env: EnvSource = process.env,
): Promise<string | null> {
  try {
    return readDriveExportConfig(env, await getIntegrationSettings(env))
      .driveId;
  } catch (error) {
    console.warn(
      "[drive] Could not read the Drive export setting; this completion is not exported:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Adds the outbox row. Called inside the completion's transaction. */
export async function enqueueDriveExport(
  database: DbExecutor,
  input: { driveId: string; envelopeId: string; nowSeconds: number },
): Promise<void> {
  await database.query(
    `
      INSERT INTO drive_exports (
        envelope_id, drive_id, status, attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES ($1, $2, 'pending', 0, $3, $3, $3)
      ON CONFLICT (envelope_id) DO NOTHING
    `,
    [input.envelopeId, input.driveId, input.nowSeconds],
  );
}

export type DriveExportRow = {
  attempts: number;
  driveId: string;
  envelopeId: string;
  /**
   * The locked_until this claim set. Every update a worker makes to the row
   * names it, so a worker whose claim was taken over changes nothing.
   */
  lease: number;
};

const RETURNING = `envelope_id AS "envelopeId", drive_id AS "driveId", attempts, locked_until AS "lease"`;

/** Takes up to `limit` rows that are due, marking them as being tried. */
export async function claimDueDriveExports(
  database: DbExecutor,
  { limit, nowSeconds }: { limit: number; nowSeconds: number },
): Promise<DriveExportRow[]> {
  return queryMany<DriveExportRow>(
    database,
    `
      UPDATE drive_exports
      SET attempts = attempts + 1, locked_until = $1::bigint + $3::bigint, updated_at = $1
      WHERE envelope_id IN (
        SELECT envelope_id FROM drive_exports
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
export async function claimDriveExport(
  database: DbExecutor,
  envelopeId: string,
  nowSeconds: number,
): Promise<DriveExportRow | null> {
  return queryOne<DriveExportRow>(
    database,
    `
      UPDATE drive_exports
      SET attempts = attempts + 1, locked_until = $2::bigint + $3::bigint, updated_at = $2
      WHERE envelope_id = $1
        AND status = 'pending'
        AND (locked_until IS NULL OR locked_until < $2)
      RETURNING ${RETURNING}
    `,
    [envelopeId, nowSeconds, CLAIM_SECONDS],
  );
}

export type ExportFile = {
  bytes: Uint8Array;
  kind: "certificate" | "signed";
  name: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function listQuery(
  driveId: string,
  q: string,
  fields: string,
  extra: { orderBy?: string; pageSize?: string } = {},
): string {
  const query = new URLSearchParams({
    corpora: "drive",
    driveId,
    fields,
    includeItemsFromAllDrives: "true",
    pageSize: extra.pageSize ?? "10",
    q,
    supportsAllDrives: "true",
  });

  if (extra.orderBy) {
    query.set("orderBy", extra.orderBy);
  }

  return query.toString();
}

/** A file already uploaded for this envelope with these exact bytes. */
export async function findExportedFile(input: {
  accessToken: string;
  driveId: string;
  envelopeId: string;
  fetchImpl: FetchLike;
  sha256: string;
}): Promise<string | null> {
  const q = [
    `appProperties has { key=${quoteDriveQuery(APP_PROPERTY_ENVELOPE)} and value=${quoteDriveQuery(input.envelopeId)} }`,
    `appProperties has { key=${quoteDriveQuery(APP_PROPERTY_SHA256)} and value=${quoteDriveQuery(input.sha256)} }`,
    "trashed = false",
  ].join(" and ");
  const body = await driveJson<{ files?: Array<{ id: string }> }>(
    input.fetchImpl,
    input.accessToken,
    "Looking for an earlier copy",
    `${DRIVE_API_BASE_URL}/files?${listQuery(input.driveId, q, "files(id)")}`,
  );

  return body.files?.[0]?.id ?? null;
}

/** The folder for these names under the Shared Drive's root, made as needed. */
export async function ensureFolderPath(input: {
  accessToken: string;
  driveId: string;
  fetchImpl: FetchLike;
  folders: readonly string[];
}): Promise<string> {
  // A Shared Drive's root folder has the drive's own id.
  let parent = input.driveId;

  // Drive allows two folders of one name, so two exports that need a new
  // folder at the same moment can each make one. Every export uses the
  // oldest folder of the name, and a duplicate made in a race stays empty.
  async function oldestFolder(name: string): Promise<string | undefined> {
    const q = [
      `name = ${quoteDriveQuery(name)}`,
      `mimeType = ${quoteDriveQuery(GOOGLE_FOLDER_MIME_TYPE)}`,
      `${quoteDriveQuery(parent)} in parents`,
      "trashed = false",
    ].join(" and ");
    const found = await driveJson<{ files?: Array<{ id: string }> }>(
      input.fetchImpl,
      input.accessToken,
      "Looking for a folder",
      `${DRIVE_API_BASE_URL}/files?${listQuery(input.driveId, q, "files(id)", {
        orderBy: "createdTime",
        pageSize: "1",
      })}`,
    );

    return found.files?.[0]?.id;
  }

  for (const name of input.folders) {
    const existing = await oldestFolder(name);

    if (existing) {
      parent = existing;
      continue;
    }

    const created = await driveJson<{ id: string }>(
      input.fetchImpl,
      input.accessToken,
      "Making a folder",
      `${DRIVE_API_BASE_URL}/files?supportsAllDrives=true&fields=id`,
      {
        body: JSON.stringify({
          mimeType: GOOGLE_FOLDER_MIME_TYPE,
          name,
          parents: [parent],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    parent = (await oldestFolder(name)) ?? created.id;
  }

  return parent;
}

export type ExportedFiles = {
  certificateFileId: string;
  folderId: string;
  signedPdfFileId: string;
  /** Files that were already there from an earlier try. */
  reused: number;
};

/**
 * Puts the files in the Shared Drive under the path, unless a copy with
 * the same envelope id and SHA-256 is already there.
 */
export async function uploadExecutedCopies(input: {
  accessToken: string;
  driveId: string;
  envelopeId: string;
  fetchImpl: FetchLike;
  files: readonly ExportFile[];
  folders: readonly string[];
}): Promise<ExportedFiles> {
  let folderId: string | null = null;
  const ids: Partial<Record<ExportFile["kind"], string>> = {};
  let reused = 0;

  for (const file of input.files) {
    const digest = sha256(file.bytes);
    const existing = await findExportedFile({
      accessToken: input.accessToken,
      driveId: input.driveId,
      envelopeId: input.envelopeId,
      fetchImpl: input.fetchImpl,
      sha256: digest,
    });

    if (existing) {
      ids[file.kind] = existing;
      reused += 1;
      continue;
    }

    folderId ??= await ensureFolderPath({
      accessToken: input.accessToken,
      driveId: input.driveId,
      fetchImpl: input.fetchImpl,
      folders: input.folders,
    });

    const uploaded = await uploadDriveFile<{ id: string }>({
      accessToken: input.accessToken,
      bytes: file.bytes,
      contentType: "application/pdf",
      fetchImpl: input.fetchImpl,
      metadata: {
        appProperties: {
          [APP_PROPERTY_ENVELOPE]: input.envelopeId,
          [APP_PROPERTY_KIND]: file.kind,
          [APP_PROPERTY_SHA256]: digest,
        },
        mimeType: "application/pdf",
        name: file.name,
        parents: [folderId],
      },
      supportsAllDrives: true,
    });

    ids[file.kind] = uploaded.id;
  }

  if (!ids.signed || !ids.certificate) {
    throw new Error("Both files are needed for an executed copy.");
  }

  return {
    certificateFileId: ids.certificate,
    folderId: folderId ?? "",
    reused,
    signedPdfFileId: ids.signed,
  };
}

export type LabelOutcome = {
  error: string | null;
  status: "applied" | "failed" | "skipped" | null;
};

/** Puts the label on the file. Never throws: the outcome is recorded. */
export async function labelExecutedCopy(input: {
  config: DriveLabelConfig;
  fetchImpl: FetchLike;
  fileId: string;
  getAccessToken: (request: GoogleAccessTokenRequest) => Promise<string>;
  values: LabelValues;
}): Promise<LabelOutcome> {
  const { config } = input;

  if (!config.labelId || Object.keys(config.fields).length === 0) {
    return { error: null, status: null };
  }

  const subject = config.subject ? { subject: config.subject } : {};

  try {
    const label = await getDriveLabel(
      config.labelId,
      await input.getAccessToken({
        scopes: [GOOGLE_SCOPES.driveLabelsReadonly],
        ...subject,
      }),
      input.fetchImpl,
    );
    const { fieldModifications, skipped } = buildLabelModification(
      label,
      config.fields,
      input.values,
    );

    if (fieldModifications.length === 0) {
      return {
        error: skipped.join("; ").slice(0, MAX_ERROR_LENGTH) || null,
        status: "skipped",
      };
    }

    await applyDriveLabel({
      accessToken: await input.getAccessToken({
        scopes: [GOOGLE_SCOPES.drive],
        ...subject,
      }),
      fetchImpl: input.fetchImpl,
      fieldModifications,
      fileId: input.fileId,
      labelId: label.id || config.labelId,
    });

    return {
      error:
        skipped.length > 0
          ? skipped.join("; ").slice(0, MAX_ERROR_LENGTH)
          : null,
      status: "applied",
    };
  } catch (error) {
    return {
      error: describeExportError(error),
      status: "failed",
    };
  }
}

export function describeExportError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The export failed.";

  return message.slice(0, MAX_ERROR_LENGTH);
}

class PermanentExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentExportError";
  }
}

export type DriveExportDeps = {
  database: DbPool;
  env: EnvSource;
  fetchImpl: FetchLike;
  getAccessToken: (request: GoogleAccessTokenRequest) => Promise<string>;
  /** Milliseconds. */
  now: () => number;
  storageService: StorageService;
};

function defaultDeps(partial: Partial<DriveExportDeps> = {}): DriveExportDeps {
  return {
    database: partial.database ?? getDb(),
    env: partial.env ?? process.env,
    fetchImpl: partial.fetchImpl ?? fetch,
    getAccessToken:
      partial.getAccessToken ??
      (async (request) => {
        const credentials = getGoogleCredentials();

        if (!credentials) {
          throw new Error(
            "This site has no Google credentials: run it on Google Cloud, or set GOOGLE_SERVICE_ACCOUNT_KEY.",
          );
        }

        return credentials.getAccessToken(request);
      }),
    now: partial.now ?? Date.now,
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
  userId: string;
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
        e.user_id AS "userId",
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

async function loadLabelValues(
  database: DbExecutor,
  envelope: EnvelopeForExport,
  env: EnvSource,
): Promise<LabelValues> {
  const [signers, teams, settings, stored] = await Promise.all([
    queryMany<{ email: string; name: string | null; role: string }>(
      database,
      `
        SELECT email, name, role FROM signers
        WHERE envelope_id = $1
        ORDER BY sign_order, created_at
      `,
      [envelope.id],
    ),
    queryMany<{ name: string }>(
      database,
      `
        SELECT t.name FROM team_members m
        JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1
        ORDER BY lower(t.name)
      `,
      [envelope.userId],
    ),
    getSettings(env),
    getIntegrationSettings(env),
  ]);
  const domains = resolveWorkspaceDomains({
    env,
    signupDomains:
      settings.signupMode === "domains" ? settings.allowedEmailDomains : [],
    stored,
  }).domains;

  return buildLabelValues({
    completedAt: envelope.completedAt ?? 0,
    counterparty: findCounterparty(signers, domains, envelope.senderEmail),
    envelopeId: envelope.id,
    senderEmail: envelope.senderEmail,
    senderName: envelope.senderName,
    senderTeams: teams.map((team) => team.name),
    title: envelope.title,
  });
}

/** One try at one claimed row. Records the outcome on the row. */
export async function exportClaimedRow(
  row: DriveExportRow,
  partialDeps: Partial<DriveExportDeps> = {},
): Promise<DriveExportStatus> {
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
      throw new PermanentExportError(
        "The envelope is no longer completed with its files, so there is nothing to export.",
      );
    }

    const stored = await getIntegrationSettings(deps.env);
    const exportConfig = readDriveExportConfig(deps.env, stored);
    const path = renderDrivePath(exportConfig.folderPattern, {
      completedAt: envelope.completedAt,
      envelopeId: envelope.id,
      senderEmail: envelope.senderEmail,
      title: envelope.title,
    });
    const baseName = path[path.length - 1] ?? envelope.id;
    const [signed, certificate] = await Promise.all([
      deps.storageService.getObject(envelope.signedPdfKey),
      deps.storageService.getObject(envelope.evidenceKey),
    ]);
    const accessToken = await deps.getAccessToken({
      scopes: [GOOGLE_SCOPES.drive],
    });
    const files = await uploadExecutedCopies({
      accessToken,
      driveId: row.driveId,
      envelopeId: envelope.id,
      fetchImpl: deps.fetchImpl,
      files: [
        { bytes: signed.body, kind: "signed", name: `${baseName}.pdf` },
        {
          bytes: certificate.body,
          kind: "certificate",
          name: `${baseName} — certificate.pdf`,
        },
      ],
      folders: path.slice(0, -1),
    });
    const labelConfig = readDriveLabelConfig(deps.env, stored);
    const label =
      labelConfig.labelId && Object.keys(labelConfig.fields).length > 0
        ? await labelExecutedCopy({
            config: labelConfig,
            fetchImpl: deps.fetchImpl,
            fileId: files.signedPdfFileId,
            getAccessToken: deps.getAccessToken,
            values: await loadLabelValues(deps.database, envelope, deps.env),
          })
        : { error: null, status: null };

    await deps.database.query(
      `
        UPDATE drive_exports
        SET
          status = 'exported',
          exported_at = $2,
          updated_at = $2,
          locked_until = NULL,
          last_error = NULL,
          folder_id = NULLIF($3, ''),
          signed_pdf_file_id = $4,
          certificate_file_id = $5,
          label_status = $6,
          label_error = $7
        WHERE envelope_id = $1 AND locked_until = $8
      `,
      [
        row.envelopeId,
        nowSeconds(),
        files.folderId,
        files.signedPdfFileId,
        files.certificateFileId,
        label.status,
        label.error,
        row.lease,
      ],
    );

    return "exported";
  } catch (error) {
    const outcome = afterFailedAttempt(
      row.attempts,
      nowSeconds(),
      error instanceof PermanentExportError,
    );

    if (
      !(error instanceof DriveApiError) &&
      !(error instanceof PermanentExportError)
    ) {
      console.warn(
        `[drive] Exporting envelope ${row.envelopeId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }

    await deps.database.query(
      `
        UPDATE drive_exports
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
export async function runDriveExportNow(
  envelopeId: string,
  partialDeps: Partial<DriveExportDeps> = {},
): Promise<DriveExportStatus | null> {
  const deps = defaultDeps(partialDeps);
  const row = await claimDriveExport(
    deps.database,
    envelopeId,
    Math.floor(deps.now() / 1000),
  );

  return row ? exportClaimedRow(row, deps) : null;
}

export type DriveExportRunSummary = {
  exported: number;
  failed: number;
  retrying: number;
  tried: number;
};

/** Tries what is due, one at a time, until the deadline or none are left. */
export async function runDueDriveExports({
  batchSize = 10,
  deadline,
  deps: partialDeps = {},
}: {
  batchSize?: number;
  /** Milliseconds: no new try starts after this. */
  deadline: number;
  deps?: Partial<DriveExportDeps>;
}): Promise<DriveExportRunSummary> {
  const deps = defaultDeps(partialDeps);
  const summary: DriveExportRunSummary = {
    exported: 0,
    failed: 0,
    retrying: 0,
    tried: 0,
  };

  while (deps.now() < deadline) {
    const rows = await claimDueDriveExports(deps.database, {
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
            UPDATE drive_exports
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
  var __signudocDriveExportsInFlight: Set<Promise<unknown>> | undefined;
}

function inFlight(): Set<Promise<unknown>> {
  globalThis.__signudocDriveExportsInFlight ??= new Set();

  return globalThis.__signudocDriveExportsInFlight;
}

/**
 * Tries the envelope's export after the completion has committed, without
 * holding up the signer. On Vercel the function is kept alive for it.
 */
export function scheduleDriveExport(
  envelopeId: string,
  partialDeps: Partial<DriveExportDeps> = {},
): void {
  const task = runDriveExportNow(envelopeId, partialDeps).catch(
    (error: unknown) => {
      console.warn(
        `[drive] The first export of envelope ${envelopeId} could not run; the retry job will try again:`,
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

/** Waits for exports started by scheduleDriveExport, for tests. */
export async function settleScheduledDriveExports(): Promise<void> {
  await Promise.all(Array.from(inFlight()));
}

export type DriveExportListItem = {
  attempts: number;
  completedAt: number | null;
  createdAt: number;
  envelopeId: string;
  exportedAt: number | null;
  labelError: string | null;
  labelStatus: string | null;
  lastError: string | null;
  nextAttemptAt: number;
  signedPdfFileId: string | null;
  status: DriveExportStatus;
  title: string;
};

/** The latest exports, newest first, for the administrator. */
export async function listDriveExports(
  database: DbExecutor = getDb(),
  { limit = 25, status }: { limit?: number; status?: DriveExportStatus } = {},
): Promise<DriveExportListItem[]> {
  return queryMany<DriveExportListItem>(
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
        x.label_status AS "labelStatus",
        x.label_error AS "labelError",
        x.signed_pdf_file_id AS "signedPdfFileId",
        x.created_at AS "createdAt",
        x.exported_at AS "exportedAt"
      FROM drive_exports x
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
 * Puts an export back in line now, with its tries counted from zero, and
 * reports whether there was one to retry. An export already done is
 * tried again too: it finds its files and only labels them again. One
 * that is being tried right now is left alone (null), so two tries of the
 * same envelope never run together.
 */
export async function requeueDriveExport(
  database: DbExecutor,
  envelopeId: string,
  nowSeconds: number,
): Promise<{ title: string } | null> {
  return queryOne<{ title: string }>(
    database,
    `
      UPDATE drive_exports x
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
