import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../../../db/test-database.ts";
import { addTeamMember, createTeam } from "../../../teams.ts";
import {
  listContractsFromDriveFile,
  listContractsWithEmail,
  recordEnvelopeSource,
} from "./contracts.ts";

// The add-on's "contracts with" list and the envelopes made from a Drive
// file, against a real Postgres. They follow the dashboard's team rule:
// your own envelopes, drafts included, and the sent ones of people on your
// teams; nobody else's. Run with `npm run test:db`.

const DAY = 24 * 60 * 60;

let database: pg.Pool;
const createdUsers: string[] = [];
const createdTeams: string[] = [];

type Account = { email: string; id: string };

let owner: Account;
let teammate: Account;
let outsider: Account;
let admin: Account;
// An address only these envelopes involve, so the shared database's other
// rows never show up.
const client = `client-${randomUUID().slice(0, 8)}@client.example`;
const ids = {
  cc: "",
  draft: "",
  other: "",
  outsiders: "",
  sent: "",
};

async function createAccount(role: "admin" | "user"): Promise<Account> {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, true, $4)
    `,
    [id, `Person ${id.slice(0, 6)}`, email, role],
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
      insert into signers (
        id, envelope_id, name, email, sign_order, signing_step, status, role
      ) values ($1, $2, 'Pat Client', $3, $4, $5, $6, $7)
    `,
    [
      randomUUID(),
      envelopeId,
      recipient.email,
      recipient.role === "cc" ? 1001 : 1,
      recipient.role === "cc" ? null : 1,
      recipient.role === "signer" && status === "sent" ? "notified" : "pending",
      recipient.role,
    ],
  );

  return envelopeId;
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  owner = await createAccount("user");
  teammate = await createAccount("user");
  outsider = await createAccount("user");
  admin = await createAccount("admin");

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
  ids.other = await createEnvelope(
    owner.id,
    "sent",
    { email: `someone-else-${randomUUID()}@client.example`, role: "signer" },
    base + 10,
  );
  ids.outsiders = await createEnvelope(
    outsider.id,
    "sent",
    { email: client, role: "signer" },
    base + 50,
  );

  const team = await createTeam(
    { email: admin.email, userId: admin.id },
    { name: `Addon ${randomUUID().slice(0, 8)}` },
    database,
  );

  createdTeams.push(team.id);

  for (const member of [owner, teammate]) {
    await addTeamMember(
      { email: admin.email, userId: admin.id },
      team.id,
      { email: member.email },
      database,
    );
  }
});

after(async () => {
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

test("the sender sees their own envelopes with the address, drafts included", async () => {
  const contracts = await listContractsWithEmail(owner.id, client, {
    database,
  });

  assert.deepEqual(
    contracts.map((item) => item.id),
    [ids.sent, ids.draft, ids.cc],
  );
  assert.deepEqual(
    contracts.map((item) => [item.mine, item.canNudge]),
    [
      [true, true],
      [true, false],
      [true, false],
    ],
  );
});

test("a teammate sees the sent ones, cannot nudge, and never the draft", async () => {
  const contracts = await listContractsWithEmail(teammate.id, client, {
    database,
  });

  assert.deepEqual(
    contracts.map((item) => item.id),
    [ids.sent, ids.cc],
  );
  assert.ok(contracts.every((item) => !item.mine && !item.canNudge));
  assert.ok(contracts.every((item) => item.ownerEmail === owner.email));
});

test("someone on no team with the sender sees only their own", async () => {
  const contracts = await listContractsWithEmail(outsider.id, client, {
    database,
  });

  assert.deepEqual(
    contracts.map((item) => item.id),
    [ids.outsiders],
  );
});

test("a reminder sent today means no nudge until the wait is over", async () => {
  await database.query(
    `update signers set last_nudged_at = $2 where envelope_id = $1`,
    [ids.sent, Math.floor(Date.now() / 1000)],
  );

  const [sent] = await listContractsWithEmail(owner.id, client, { database });

  assert.equal(sent?.id, ids.sent);
  assert.equal(sent?.canNudge, false);

  const later = await listContractsWithEmail(owner.id, client, {
    database,
    nowUnixTimestamp: Math.floor(Date.now() / 1000) + 2 * DAY,
  });

  assert.equal(later[0]?.canNudge, true);
});

test("a draft made from a Drive file is listed with that file, for its sender only", async () => {
  const fileId = `drive-${randomUUID()}`;

  await recordEnvelopeSource(
    { envelopeId: ids.draft, kind: "drive", ref: fileId, userId: owner.id },
    database,
  );
  // Someone else's draft, and a second source, change nothing.
  await recordEnvelopeSource(
    { envelopeId: ids.draft, kind: "drive", ref: "other", userId: teammate.id },
    database,
  );
  await recordEnvelopeSource(
    { envelopeId: ids.draft, kind: "drive", ref: "later", userId: owner.id },
    database,
  );

  assert.deepEqual(
    (await listContractsFromDriveFile(owner.id, fileId, { database })).map(
      (item) => item.id,
    ),
    [ids.draft],
  );
  assert.deepEqual(
    await listContractsFromDriveFile(teammate.id, fileId, { database }),
    [],
  );
  // A sent envelope's source is not changed either.
  await recordEnvelopeSource(
    { envelopeId: ids.sent, kind: "drive", ref: fileId, userId: owner.id },
    database,
  );
  assert.equal(
    (await listContractsFromDriveFile(owner.id, fileId, { database })).length,
    1,
  );
});
