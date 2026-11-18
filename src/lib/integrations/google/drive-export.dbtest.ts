import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "../../db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "../../electronic-records-disclosure.ts";
import { issueSigningLink } from "../../services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "../../services/storage.ts";
import { recordSignerConsent, submitSigningForToken } from "../../signing.ts";
import { DRIVE_API_BASE_URL, DRIVE_UPLOAD_BASE_URL } from "./drive-api.ts";
import {
  claimDriveExport,
  claimDueDriveExports,
  exportClaimedRow,
  requeueDriveExport,
  settleScheduledDriveExports,
} from "./drive-export.ts";

// The executed-copy outbox against a real Postgres: its row is written in
// the transaction that completes the envelope (and rolled back with it),
// the retry job takes only rows that are due, and a try records what
// happened. Run with `npm run test:db`.

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
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-drive-export-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    // The Shared Drive is chosen through the environment, which wins over
    // anything saved in Settings.
    GOOGLE_DRIVE_EXPORT_DRIVE_ID: SHARED_DRIVE,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await settleScheduledDriveExports();
  delete process.env.GOOGLE_DRIVE_EXPORT_DRIVE_ID;
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

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
    drive_id: string;
    last_error: string | null;
    status: string;
  }>(
    `select drive_id, status, attempts, last_error from drive_exports where envelope_id = $1`,
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

test("completing an envelope writes its export, in the same transaction", async () => {
  const envelope = await createSignableEnvelope();

  await sign(envelope);
  // The first try runs after the commit; without Google it waits to retry.
  await settleScheduledDriveExports();

  assert.equal(await envelopeStatus(envelope.envelopeId), "completed");

  const row = await exportRow(envelope.envelopeId);

  assert.ok(row);
  assert.equal(row.drive_id, SHARED_DRIVE);
  assert.notEqual(row.status, "failed");
});

test("a completion that rolls back leaves no export behind", async () => {
  const envelope = await createSignableEnvelope();
  const failing = afterStatement(
    database,
    (text) => /insert into drive_exports/i.test(text),
    async () => {
      throw new Error("Stopped right after the export row.");
    },
  );

  await assert.rejects(sign(envelope, failing));

  assert.equal(await envelopeStatus(envelope.envelopeId), "sent");
  assert.equal(await exportRow(envelope.envelopeId), null);
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
      insert into drive_exports (
        envelope_id, drive_id, status, attempts, next_attempt_at,
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

test("the retry job takes only exports that are due and not being tried", async () => {
  // Rows left by other tests are taken out of the way first.
  await database.query(
    `update drive_exports set status = 'exported' where status = 'pending'`,
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

  const claimed = await claimDueDriveExports(database, {
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
    await claimDueDriveExports(database, { limit: 10, nowSeconds: now }),
    [],
  );
  assert.equal(await claimDriveExport(database, beingTried, now), null);
  assert.equal(await claimDriveExport(database, due, now), null);

  // A row that is not due yet can still be tried at once, as after completion.
  assert.equal((await claimDriveExport(database, later, now))?.attempts, 1);
});

test("a failed try waits to retry; a good one records the files", async () => {
  const now = unixNow();
  const failing = await createExport({ nextAttemptAt: now, status: "pending" });
  const failingRow = await claimDriveExport(database, failing, now);

  assert.ok(failingRow);
  assert.equal(
    await exportClaimedRow(failingRow, {
      database,
      getAccessToken: async () => {
        throw new Error("No Google credentials in this test.");
      },
      now: () => now * 1000,
      storageService,
    }),
    "pending",
  );

  const waiting = await database.query<{
    last_error: string;
    locked_until: number | null;
    next_attempt_at: number;
  }>(
    `select next_attempt_at, locked_until, last_error from drive_exports where envelope_id = $1`,
    [failing],
  );

  assert.equal(waiting.rows[0]?.next_attempt_at, now + 5 * 60);
  assert.equal(waiting.rows[0]?.locked_until, null);
  assert.match(waiting.rows[0]?.last_error ?? "", /No Google credentials/);

  const good = await createExport({ nextAttemptAt: now, status: "pending" });
  const goodRow = await claimDriveExport(database, good, now);
  let upload = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET" && url.startsWith(`${DRIVE_API_BASE_URL}/files?`)) {
      return Response.json({ files: [] });
    }

    if (method === "POST" && url.startsWith(`${DRIVE_API_BASE_URL}/files?`)) {
      return Response.json({ id: "folder-1" });
    }

    if (method === "POST" && url.startsWith(DRIVE_UPLOAD_BASE_URL)) {
      upload += 1;

      return new Response(null, {
        headers: {
          location: `${DRIVE_UPLOAD_BASE_URL}/files?upload_id=${String(upload)}`,
        },
      });
    }

    if (method === "PUT") {
      return Response.json({
        id: `file-${new URL(url).searchParams.get("upload_id") ?? ""}`,
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  assert.ok(goodRow);
  assert.equal(
    await exportClaimedRow(goodRow, {
      database,
      fetchImpl,
      getAccessToken: async () => "service-account-token",
      now: () => now * 1000,
      storageService,
    }),
    "exported",
  );

  const done = await database.query<{
    certificate_file_id: string;
    signed_pdf_file_id: string;
    status: string;
  }>(
    `select status, signed_pdf_file_id, certificate_file_id from drive_exports where envelope_id = $1`,
    [good],
  );

  assert.deepEqual(done.rows[0], {
    certificate_file_id: "file-2",
    signed_pdf_file_id: "file-1",
    status: "exported",
  });
});

test("an export being tried is not put back in line under the attempt that holds it", async () => {
  const now = unixNow();
  const beingTried = await createExport({
    attempts: 1,
    lockedUntil: now + 300,
    nextAttemptAt: now - 60,
    status: "pending",
  });

  assert.equal(await requeueDriveExport(database, beingTried, now), null);

  const held = await database.query<{ attempts: number; locked_until: string }>(
    `select attempts, locked_until from drive_exports where envelope_id = $1`,
    [beingTried],
  );

  assert.equal(Number(held.rows[0]?.locked_until), now + 300);
  assert.equal(held.rows[0]?.attempts, 1);

  // Once the lock has lapsed it can be retried.
  const lapsed = await createExport({
    attempts: 2,
    lockedUntil: now - 1,
    nextAttemptAt: now - 60,
    status: "failed",
  });

  assert.deepEqual(await requeueDriveExport(database, lapsed, now), {
    title: "Lease",
  });
});
