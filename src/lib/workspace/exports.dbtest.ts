import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "../db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "../electronic-records-disclosure.ts";
import { issueSigningLink } from "../services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import { recordSignerConsent, submitSigningForToken } from "../signing.ts";
import {
  claimDueWorkspaceExports,
  claimWorkspaceExport,
  exportClaimedRow,
  listWorkspaceExports,
  requeueWorkspaceExport,
  settleScheduledWorkspaceExports,
} from "./exports.ts";
import { invalidateWorkspaceSettingsCache } from "./settings.ts";
import {
  ExportError,
  type ExportRequest,
  type WorkspaceFiles,
} from "./types.ts";

// The copy of completed envelopes against a real Postgres: its outbox row
// is written in the transaction that completes the envelope (and rolled
// back with it), the retry job takes only rows that are due, and a try
// records what happened. The provider is a stand-in. Run with
// `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
const SHARED_DRIVE = "0ATestSharedDrive";

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-workspace-export-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await settleScheduledWorkspaceExports();
  delete process.env.WORKSPACE_PROVIDER;
  delete process.env.WORKSPACE_EXPORT_DESTINATION;
  invalidateWorkspaceSettingsCache();
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

/** Turns the copy on, through the environment, for one test. */
function withExportsOn() {
  process.env.WORKSPACE_PROVIDER = "google";
  process.env.WORKSPACE_EXPORT_DESTINATION = SHARED_DRIVE;
}

function withExportsOff() {
  delete process.env.WORKSPACE_PROVIDER;
  delete process.env.WORKSPACE_EXPORT_DESTINATION;
}

/** A stand-in for the provider's files that records each export. */
function recordingFiles(
  answer: (request: ExportRequest) => Promise<{
    files: Array<{ id: string; kind: "certificate" | "signed"; url: null }>;
    metadataProblem: string | null;
  }>,
) {
  const requests: ExportRequest[] = [];
  const files = {
    exportExecutedCopies: async (request: ExportRequest) => {
      requests.push(request);

      return answer(request);
    },
  } as unknown as WorkspaceFiles;

  return { files: async () => files, requests };
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function createUser() {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

/** An envelope waiting on its one signer, with a real document behind it. */
async function createSignableEnvelope() {
  const userId = await createUser();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const fieldId = randomUUID();
  const now = unixNow();
  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
      now,
      now + DAY,
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified', $4, $5, $6)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@customer.example`,
      link.tokenHash,
      link.exp,
      now,
    ],
  );
  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height
      ) values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
    `,
    [fieldId, envelopeId, signerId],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  return { envelopeId, fieldId, token: link.token, userId };
}

function sign(
  envelope: Awaited<ReturnType<typeof createSignableEnvelope>>,
  pool: pg.Pool = database,
) {
  return submitSigningForToken(
    envelope.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: envelope.fieldId,
          inputMethod: "typed",
          type: "signature",
          value: "Riley Recipient",
        },
      ],
    },
    { database: pool, storageService },
  );
}

async function exportRow(envelopeId: string) {
  const result = await database.query<{
    attempts: number;
    destination: string;
    last_error: string | null;
    status: string;
  }>(
    `select destination, status, attempts, last_error from workspace_exports where envelope_id = $1`,
    [envelopeId],
  );

  return result.rows[0] ?? null;
}

async function envelopeStatus(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status ?? null;
}

test("completing an envelope writes its copy, in the same transaction", async () => {
  withExportsOn();

  try {
    const envelope = await createSignableEnvelope();

    await sign(envelope);
    // The first try runs after the commit; without Google it waits to retry.
    await settleScheduledWorkspaceExports();

    assert.equal(await envelopeStatus(envelope.envelopeId), "completed");

    const row = await exportRow(envelope.envelopeId);

    assert.ok(row);
    assert.equal(row.destination, SHARED_DRIVE);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
  } finally {
    withExportsOff();
  }
});

test("without a provider, completing an envelope writes no copy", async () => {
  withExportsOff();

  const envelope = await createSignableEnvelope();

  await sign(envelope);

  assert.equal(await envelopeStatus(envelope.envelopeId), "completed");
  assert.equal(await exportRow(envelope.envelopeId), null);
});

test("a completion that rolls back leaves no copy behind", async () => {
  withExportsOn();

  try {
    const envelope = await createSignableEnvelope();
    const failing = afterStatement(
      database,
      (text) => /insert into workspace_exports/i.test(text),
      async () => {
        throw new Error("Stopped right after the export row.");
      },
    );

    await assert.rejects(sign(envelope, failing));

    assert.equal(await envelopeStatus(envelope.envelopeId), "sent");
    assert.equal(await exportRow(envelope.envelopeId), null);
  } finally {
    withExportsOff();
  }
});

/** A completed envelope with its files stored, and an export row. */
async function createExport(input: {
  attempts?: number;
  lockedUntil?: number | null;
  nextAttemptAt: number;
  status: "exported" | "failed" | "pending";
}) {
  const userId = await createUser();
  const envelopeId = randomUUID();
  const now = unixNow();
  const signedKey = `test/${envelopeId}/signed.pdf`;
  const evidenceKey = `test/${envelopeId}/internal.pdf`;

  await storageService.putObject({
    body: new TextEncoder().encode("%PDF signed"),
    contentType: "application/pdf",
    key: signedKey,
  });
  await storageService.putObject({
    body: new TextEncoder().encode("%PDF certificate"),
    contentType: "application/pdf",
    key: evidenceKey,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, signed_pdf_key, evidence_key
      ) values ($1, $2, 'Lease', 'completed', $3, 'lease.pdf', 10, 1, $4, $5, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      now,
      signedKey,
      evidenceKey,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status, role
      ) values ($1, $2, 'Pat Customer', 'pat@customer.example', 1, 'signed', 'signer')
    `,
    [randomUUID(), envelopeId],
  );
  await database.query(
    `
      insert into workspace_exports (
        envelope_id, destination, status, attempts, next_attempt_at,
        locked_until, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $7)
    `,
    [
      envelopeId,
      SHARED_DRIVE,
      input.status,
      input.attempts ?? 0,
      input.nextAttemptAt,
      input.lockedUntil ?? null,
      now,
    ],
  );

  return envelopeId;
}

test("the retry job takes only copies that are due and not being made", async () => {
  // Rows left by other tests are taken out of the way first.
  await database.query(
    `update workspace_exports set status = 'exported' where status = 'pending'`,
  );

  const now = unixNow();
  const due = await createExport({
    nextAttemptAt: now - 60,
    status: "pending",
  });
  const later = await createExport({
    nextAttemptAt: now + 3600,
    status: "pending",
  });
  const beingTried = await createExport({
    lockedUntil: now + 300,
    nextAttemptAt: now - 60,
    status: "pending",
  });
  const staleClaim = await createExport({
    attempts: 2,
    lockedUntil: now - 1,
    nextAttemptAt: now - 60,
    status: "pending",
  });

  await createExport({ nextAttemptAt: now - 60, status: "exported" });
  await createExport({ nextAttemptAt: now - 60, status: "failed" });

  const claimed = await claimDueWorkspaceExports(database, {
    limit: 10,
    nowSeconds: now,
  });

  assert.deepEqual(
    claimed.map((row) => row.envelopeId).sort(),
    [due, staleClaim].sort(),
  );
  assert.equal(
    claimed.find((row) => row.envelopeId === staleClaim)?.attempts,
    3,
  );

  // Claimed rows are not handed out twice.
  assert.deepEqual(
    await claimDueWorkspaceExports(database, { limit: 10, nowSeconds: now }),
    [],
  );
  assert.equal(await claimWorkspaceExport(database, beingTried, now), null);
  assert.equal(await claimWorkspaceExport(database, due, now), null);

  // A row that is not due yet can still be tried at once, as after completion.
  assert.equal((await claimWorkspaceExport(database, later, now))?.attempts, 1);
});

test("a failed try waits to retry; a good one records the files", async () => {
  const now = unixNow();
  const failing = await createExport({ nextAttemptAt: now, status: "pending" });
  const failingRow = await claimWorkspaceExport(database, failing, now);

  assert.ok(failingRow);
  assert.equal(
    await exportClaimedRow(failingRow, {
      database,
      files: recordingFiles(async () => {
        throw new ExportError("The Shared Drive could not be reached.");
      }).files,
      now: () => now * 1000,
      settings: async () => null,
      storageService,
    }),
    "pending",
  );

  const waiting = await database.query<{
    last_error: string;
    locked_until: number | null;
    next_attempt_at: number;
  }>(
    `select next_attempt_at, locked_until, last_error from workspace_exports where envelope_id = $1`,
    [failing],
  );

  assert.equal(Number(waiting.rows[0]?.next_attempt_at), now + 5 * 60);
  assert.equal(waiting.rows[0]?.locked_until, null);
  assert.match(waiting.rows[0]?.last_error ?? "", /could not be reached/);

  const good = await createExport({ nextAttemptAt: now, status: "pending" });
  const goodRow = await claimWorkspaceExport(database, good, now);
  const recording = recordingFiles(async () => ({
    files: [
      { id: "file-1", kind: "signed", url: null },
      { id: "file-2", kind: "certificate", url: null },
    ],
    metadataProblem: "Owner: a person field needs an email address",
  }));

  assert.ok(goodRow);
  assert.equal(
    await exportClaimedRow(goodRow, {
      database,
      files: recording.files,
      now: () => now * 1000,
      settings: async () => ({ "files.exportFolderPattern": "{yyyy}/{title}" }),
      storageService,
    }),
    "exported",
  );

  const request = recording.requests[0];

  assert.ok(request);
  assert.equal(request.destination, SHARED_DRIVE);
  assert.deepEqual(request.folderPath, [
    String(new Date(now * 1000).getUTCFullYear()),
  ]);
  assert.deepEqual(
    request.copies.map((copy) => [copy.kind, copy.fileName]),
    [
      ["signed", "Lease.pdf"],
      ["certificate", "Lease — certificate.pdf"],
    ],
  );
  assert.equal(
    request.copies[0]?.sha256,
    createHash("sha256").update("%PDF signed").digest("hex"),
  );
  assert.equal(request.metadata.counterparty, "Pat Customer");

  const [listed] = (
    await listWorkspaceExports(database, { limit: 100 })
  ).filter((item) => item.envelopeId === good);

  assert.equal(listed?.status, "exported");
  assert.deepEqual(
    listed?.files?.map((file) => file.id),
    ["file-1", "file-2"],
  );
  assert.match(listed?.metadataProblem ?? "", /person field/);
});

test("a copy of an envelope that is no longer completed is given up at once", async () => {
  const now = unixNow();
  const id = await createExport({ nextAttemptAt: now, status: "pending" });

  await database.query(`update envelopes set status = 'voided' where id = $1`, [
    id,
  ]);

  const row = await claimWorkspaceExport(database, id, now);

  assert.ok(row);
  assert.equal(
    await exportClaimedRow(row, {
      database,
      files: recordingFiles(async () => {
        throw new Error("Not called.");
      }).files,
      now: () => now * 1000,
      settings: async () => null,
      storageService,
    }),
    "failed",
  );
});

test("a copy being made is not requeued, and a claim that was taken over changes nothing", async () => {
  const now = unixNow();
  const id = await createExport({ nextAttemptAt: now - 60, status: "pending" });
  const first = await claimWorkspaceExport(database, id, now);

  assert.ok(first);

  // Retry pressed while the copy is being made: nothing is reset.
  assert.equal(await requeueWorkspaceExport(database, id, now), null);

  // The first worker is slow: its claim lapses, a second worker takes the
  // row over and finishes it.
  await database.query(
    `update workspace_exports set locked_until = $2 where envelope_id = $1`,
    [id, now - 1],
  );
  assert.ok(await claimWorkspaceExport(database, id, now + 700));
  await database.query(
    `
      update workspace_exports
      set status = 'exported', locked_until = null,
        exported_files = '[{"id":"file-signed","kind":"signed","url":null}]'
      where envelope_id = $1
    `,
    [id],
  );

  // The first worker then fails: it must not undo the second one's result.
  await exportClaimedRow(first, {
    database,
    files: recordingFiles(async () => {
      throw new ExportError("No Google credentials in this test.");
    }).files,
    now: () => now * 1000,
    settings: async () => null,
    storageService,
  });

  const after = await database.query<{ status: string }>(
    `select status from workspace_exports where envelope_id = $1`,
    [id],
  );

  assert.equal(after.rows[0]?.status, "exported");

  // A row nobody is making can be requeued.
  assert.deepEqual(await requeueWorkspaceExport(database, id, now), {
    title: "Lease",
  });
});
