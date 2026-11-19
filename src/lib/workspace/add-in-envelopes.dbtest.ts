import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import {
  createStorageService,
  type StorageService,
} from "../services/storage.ts";
import {
  listEnvelopesFromSource,
  listEnvelopesWithEmail,
  recordEnvelopeSource,
} from "./add-in-envelopes.ts";
import { createAddInDraft, findAddInAccount } from "./add-in-support.ts";

// A workspace add-in's account lookup, drafts and envelope lists, against
// a real Postgres and real files: only the person's own envelopes are
// listed, drafts included, and a draft remembers where its document came
// from. Run with `npm run test:db`.

const DAY = 24 * 60 * 60;

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let sourcePdf: Uint8Array;
const createdUsers: string[] = [];
const suffix = randomUUID().slice(0, 8);
// An address only these envelopes involve, so the shared database's other
// rows never show up.
const client = `client-${suffix}@client.example`;

type Account = { email: string; id: string };

let owner: Account;
let other: Account;
const ids = { cc: "", draft: "", others: "", sent: "", unrelated: "" };

async function createAccount(emailVerified = true): Promise<Account> {
  const id = randomUUID();
  const email = `${id}@addin-${suffix}.example`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, 'Sam Sender', $2, $3, 'user')
    `,
    [id, email, emailVerified],
  );

  return { email, id };
}

async function createEnvelope(
  ownerId: string,
  status: "draft" | "sent",
  recipient: { email: string; role: "cc" | "signer" },
  updatedAt: number,
): Promise<string> {
  const envelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, 'contract.pdf', 4, 1, $6, $7, $8, $9, $9
      )
    `,
    [
      envelopeId,
      ownerId,
      `Contract ${status}`,
      status,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      status === "draft" ? null : now,
      status === "sent" ? now + 30 * DAY : null,
      updatedAt,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status, role)
      values ($1, $2, 'Pat Client', $3, $4, $5, $6)
    `,
    [
      randomUUID(),
      envelopeId,
      recipient.email,
      recipient.role === "cc" ? 1001 : 1,
      recipient.role === "signer" && status === "sent" ? "notified" : "pending",
      recipient.role,
    ],
  );

  return envelopeId;
}

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-add-in-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();

  owner = await createAccount();
  other = await createAccount();

  const base = Math.floor(Date.now() / 1000);

  ids.sent = await createEnvelope(
    owner.id,
    "sent",
    { email: client, role: "signer" },
    base + 40,
  );
  ids.draft = await createEnvelope(
    owner.id,
    "draft",
    { email: client.toUpperCase(), role: "signer" },
    base + 30,
  );
  ids.cc = await createEnvelope(
    owner.id,
    "sent",
    { email: client, role: "cc" },
    base + 20,
  );
  ids.unrelated = await createEnvelope(
    owner.id,
    "sent",
    { email: `someone-else-${suffix}@client.example`, role: "signer" },
    base + 10,
  );
  ids.others = await createEnvelope(
    other.id,
    "sent",
    { email: client, role: "signer" },
    base + 50,
  );
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

test("only the person's own envelopes with the address are listed, newest first", async () => {
  const listed = await listEnvelopesWithEmail(owner.id, client.toUpperCase(), {
    database,
  });

  assert.deepEqual(
    listed.map((envelope) => envelope.id),
    [ids.sent, ids.draft, ids.cc],
  );
  // Waiting on a signer, never reminded: it can be nudged now.
  assert.equal(listed[0]?.canNudge, true);
  assert.equal(listed[1]?.canNudge, false);
  assert.equal(listed[2]?.canNudge, false);

  assert.deepEqual(
    (await listEnvelopesWithEmail(other.id, client, { database })).map(
      (envelope) => envelope.id,
    ),
    [ids.others],
  );
});

test("a source is noted once, on the person's own draft only", async () => {
  const file = {
    kind: "file" as const,
    provider: "google",
    ref: `f-${suffix}`,
  };

  // Someone else's draft, or a sent envelope, is left alone.
  await recordEnvelopeSource(
    { envelopeId: ids.draft, source: file, userId: other.id },
    database,
  );
  await recordEnvelopeSource(
    { envelopeId: ids.sent, source: file, userId: owner.id },
    database,
  );
  assert.deepEqual(
    await listEnvelopesFromSource(owner.id, file, { database }),
    [],
  );

  await recordEnvelopeSource(
    { envelopeId: ids.draft, source: file, userId: owner.id },
    database,
  );
  await recordEnvelopeSource(
    {
      envelopeId: ids.draft,
      source: { ...file, ref: "another" },
      userId: owner.id,
    },
    database,
  );

  assert.deepEqual(
    (await listEnvelopesFromSource(owner.id, file, { database })).map(
      (envelope) => envelope.id,
    ),
    [ids.draft],
  );
  assert.deepEqual(
    await listEnvelopesFromSource(other.id, file, { database }),
    [],
  );
  assert.deepEqual(
    await listEnvelopesFromSource(
      owner.id,
      { ...file, provider: "microsoft" },
      { database },
    ),
    [],
  );
});

test("a draft from an add-in notes its source and suggests the signer", async () => {
  const source = {
    kind: "mail" as const,
    provider: "google",
    ref: `msg-${suffix}/2`,
  };
  const draft = await createAddInDraft(
    {
      bytes: sourcePdf,
      fileName: "Offer_letter.pdf",
      signer: { email: client, name: "Pat Client" },
      source,
      userId: owner.id,
    },
    { database, storageService },
  );

  assert.equal(draft.signerAdded, true);
  assert.equal(draft.path, `/envelopes/${draft.envelopeId}/signers`);

  const row = await database.query<{
    source_kind: string;
    source_provider: string;
    source_ref: string;
    title: string;
  }>(
    `select title, source_provider, source_kind, source_ref from envelopes where id = $1`,
    [draft.envelopeId],
  );

  assert.deepEqual(row.rows[0], {
    source_kind: "mail",
    source_provider: "google",
    source_ref: source.ref,
    title: "Offer letter",
  });

  const signers = await database.query<{ email: string }>(
    `select email from signers where envelope_id = $1`,
    [draft.envelopeId],
  );

  assert.deepEqual(
    signers.rows.map((signer) => signer.email),
    [client],
  );
  assert.deepEqual(
    (await listEnvelopesFromSource(owner.id, source, { database })).map(
      (envelope) => envelope.id,
    ),
    [draft.envelopeId],
  );
});

test("the account is found by its address, and only when verified", async () => {
  const unverified = await createAccount(false);

  assert.deepEqual(
    await findAddInAccount(owner.email.toUpperCase(), database),
    {
      account: { email: owner.email, id: owner.id, name: "Sam Sender" },
      kind: "found",
    },
  );
  assert.deepEqual(await findAddInAccount(unverified.email, database), {
    kind: "unverified",
  });
  assert.deepEqual(
    await findAddInAccount(`nobody-${suffix}@example.test`, database),
    { kind: "no_account" },
  );
});
