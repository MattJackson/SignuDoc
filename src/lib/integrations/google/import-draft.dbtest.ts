import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "../../db/test-database.ts";
import {
  createStorageService,
  type StorageService,
} from "../../services/storage.ts";
import { listContractsFromDriveFile } from "./addon/contracts.ts";
import { createDraftFromDocument } from "./import-draft.ts";

// A draft made from a Google document, against a real database. Run with
// `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let userId: string;

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-import-draft-"));
  Object.assign(process.env, {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
  userId = randomUUID();
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, 'Sam Sender', $2, true, 'user')
    `,
    [userId, `${userId}@example.test`],
  );
});

after(async () => {
  await database.query(`delete from envelopes where user_id = $1`, [userId]);
  await database.query(`delete from public."user" where id = $1`, [userId]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function pdfBytes() {
  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);

  return pdf.save();
}

test("a draft made from a Drive file is listed with that file", async () => {
  const fileId = `drive-${randomUUID()}`;
  const { envelopeId } = await createDraftFromDocument(
    {
      bytes: await pdfBytes(),
      fileName: "Lease.pdf",
      source: { kind: "drive", ref: fileId },
      userId,
    },
    { database, storageService },
  );
  const stored = await database.query<{
    source_kind: string | null;
    source_ref: string | null;
  }>(`select source_kind, source_ref from envelopes where id = $1`, [
    envelopeId,
  ]);

  assert.deepEqual(stored.rows[0], {
    source_kind: "drive",
    source_ref: fileId,
  });
  assert.deepEqual(
    (await listContractsFromDriveFile(userId, fileId, { database })).map(
      (item) => item.id,
    ),
    [envelopeId],
  );
});

test("a draft from an upload has no source noted", async () => {
  const { envelopeId } = await createDraftFromDocument(
    {
      bytes: await pdfBytes(),
      fileName: "Upload.pdf",
      source: { kind: "upload" },
      userId,
    },
    { database, storageService },
  );
  const stored = await database.query<{ source_kind: string | null }>(
    `select source_kind from envelopes where id = $1`,
    [envelopeId],
  );

  assert.equal(stored.rows[0]?.source_kind, null);
});
