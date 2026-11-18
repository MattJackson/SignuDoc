import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
  getReviewEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { invalidateIntegrationSettingsCache } from "./integration-settings.ts";
import type {
  DirectoryClient,
  DirectoryUser,
} from "./integrations/google/directory.ts";
import {
  checkManagerPolicy,
  managerPolicyAppliesTo,
  type ManagerPolicy,
} from "./manager-policy.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// The administrator's rule about the sender's manager, against a real
// Postgres: in require mode a send without the manager approving first is
// refused with the reason, a send with them goes out, and a rule limited
// to chosen teams only covers their members. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];
const createdTeams: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-manager-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(workDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: workDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(workDir, { force: true, recursive: true });
});

function directoryFor(
  senderEmail: string,
  managerEmail: string | null,
): DirectoryClient {
  const entries = new Map<string, Partial<DirectoryUser>>([
    [senderEmail, { managerEmail }],
    ...(managerEmail
      ? [
          [managerEmail, { name: "Bea Boss" }] as [
            string,
            Partial<DirectoryUser>,
          ],
        ]
      : []),
  ]);

  return {
    getUser: async (email) => {
      const entry = entries.get(email.toLowerCase());

      return entry
        ? {
            archived: false,
            email: email.toLowerCase(),
            managerEmail: null,
            name: "",
            suspended: false,
            ...entry,
          }
        : null;
    },
    isGroupMember: async () => false,
    listUserGroups: async () => [],
    searchUsers: async () => [],
  };
}

const requireForEveryone: ManagerPolicy = {
  mode: "require",
  source: "settings",
  teamIds: [],
};

/** A draft whose signing order is these people, each with a field if a signer. */
async function createDraft(
  people: ReadonlyArray<{
    email: string;
    role: "approver" | "signer";
    step: number;
  }>,
) {
  const userId = randomUUID();
  const senderEmail = `sender-${userId}@example.test`;
  const envelopeId = randomUUID();
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const bytes = await sourcePdf.save();
  const key = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: bytes,
    contentType: "application/pdf",
    key,
  });
  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, senderEmail],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Contract', 'draft', $3, 'contract.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      key,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: people.map((person, index) => ({
        email: person.email,
        name: `Person ${String(index + 1)}`,
        role: person.role,
        signingStep: person.step,
      })),
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: saved.signers
        .filter((signer) => signer.role === "signer")
        .map((signer, index) => ({
          height: 0.05,
          page: 1,
          required: true,
          signerId: signer.id,
          type: "signature",
          width: 0.2,
          x: 0.1,
          y: 0.1 + index * 0.1,
        })),
    },
    database,
  );

  return { envelopeId, senderEmail, userId };
}

async function statusOf(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status;
}

const send = { senderEmail: "sam@example.test", senderName: "Sam Sender" };

test("require mode refuses a send without the manager approving first, and says who", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);
  const directory = directoryFor(draft.senderEmail, manager);

  await assert.rejects(
    sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
      database,
      directory,
      managerPolicy: requireForEveryone,
    }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /Bea Boss/.test(error.message) &&
      /approver in the first step/.test(error.message),
  );
  assert.equal(await statusOf(draft.envelopeId), "draft");
});

test("require mode lets a send through with the manager approving in the first step", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const draft = await createDraft([
    { email: manager, role: "approver", step: 1 },
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 2 },
  ]);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
    database,
    directory: directoryFor(draft.senderEmail, manager),
    managerPolicy: requireForEveryone,
  });

  assert.equal(await statusOf(draft.envelopeId), "sent");
});

test("require mode with no manager in the directory blocks with an explanation", async () => {
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);

  await assert.rejects(
    sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
      database,
      directory: directoryFor(draft.senderEmail, null),
      managerPolicy: requireForEveryone,
    }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /names no manager/.test(error.message),
  );

  // With the directory off, the rule cannot be met either.
  await assert.rejects(
    sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
      database,
      directory: null,
      managerPolicy: requireForEveryone,
    }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /directory is not turned on/.test(error.message),
  );
  assert.equal(await statusOf(draft.envelopeId), "draft");
});

test("a rule limited to chosen teams covers only their members", async () => {
  const member = randomUUID();
  const outsider = randomUUID();
  const teamId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  for (const id of [member, outsider]) {
    createdUsers.push(id);
    await database.query(
      `insert into public."user" (id, name, email, role) values ($1, 'Person', $2, 'user')`,
      [id, `${id}@example.test`],
    );
  }

  createdTeams.push(teamId);
  await database.query(
    `insert into teams (id, name, created_at, updated_at) values ($1, $2, $3, $3)`,
    [teamId, `Sales ${teamId}`, now],
  );
  await database.query(
    `insert into team_members (team_id, user_id, added_at) values ($1, $2, $3)`,
    [teamId, member, now],
  );

  const salesOnly: ManagerPolicy = {
    mode: "require",
    source: "settings",
    teamIds: [teamId],
  };

  assert.equal(await managerPolicyAppliesTo(member, salesOnly, database), true);
  assert.equal(
    await managerPolicyAppliesTo(outsider, salesOnly, database),
    false,
  );
  assert.equal(
    await managerPolicyAppliesTo(
      member,
      { ...salesOnly, mode: "off" },
      database,
    ),
    false,
  );
});

test("with no rule the review page says nothing about the manager", async () => {
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);
  // The review page reads the rule from the settings; with none stored it
  // is off and the page has nothing to say about the manager.
  const review = await getReviewEnvelopeDataForUser(
    draft.userId,
    draft.envelopeId,
    database,
  );

  assert.ok(review);
  assert.equal(review.managerSuggestion, null);
  assert.equal(review.canSend, true);
});

test("a rule limited only to teams that no longer exist covers everyone", async () => {
  const member = randomUUID();
  const outsider = randomUUID();
  const teamId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  for (const id of [member, outsider]) {
    createdUsers.push(id);
    await database.query(
      `insert into public."user" (id, name, email, role) values ($1, 'Person', $2, 'user')`,
      [id, `${id}@example.test`],
    );
  }

  createdTeams.push(teamId);
  await database.query(
    `insert into teams (id, name, created_at, updated_at) values ($1, $2, $3, $3)`,
    [teamId, `Gone ${teamId}`, now],
  );
  await database.query(
    `insert into team_members (team_id, user_id, added_at) values ($1, $2, $3)`,
    [teamId, member, now],
  );

  const goneTeamOnly: ManagerPolicy = {
    mode: "require",
    source: "settings",
    teamIds: [teamId],
  };

  assert.equal(
    await managerPolicyAppliesTo(outsider, goneTeamOnly, database),
    false,
  );

  await database.query(`delete from teams where id = $1`, [teamId]);

  // The settings page shows no team limit now, which means everyone.
  assert.equal(
    await managerPolicyAppliesTo(outsider, goneTeamOnly, database),
    true,
  );

  const outsiderEmail = `${outsider}@example.test`;
  const check = await checkManagerPolicy(
    { email: outsiderEmail, id: outsider },
    [],
    {
      database,
      directory: directoryFor(outsiderEmail, null),
      policy: goneTeamOnly,
    },
  );

  assert.equal(check.status, "blocked");
});

test("correcting a sent approver cannot replace the manager the rule requires", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const draft = await createDraft([
    { email: manager, role: "approver", step: 1 },
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 2 },
  ]);
  const directory = directoryFor(draft.senderEmail, manager);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
    database,
    directory,
    managerPolicy: requireForEveryone,
  });

  const approver = await database.query<{ id: string }>(
    `select id from signers where envelope_id = $1 and role = 'approver'`,
    [draft.envelopeId],
  );
  // Not written inline: the option for the directory arrives with the fix.
  const correctionOptions = { database, directory };
  const previous = process.env.MANAGER_APPROVAL;

  process.env.MANAGER_APPROVAL = "require";

  try {
    await assert.rejects(
      correctSentEnvelopeSigner(
        draft.userId,
        draft.envelopeId,
        approver.rows[0]!.id,
        { email: `mine-${randomUUID()}@example.test` },
        { senderEmail: draft.senderEmail, senderName: "Sam Sender" },
        correctionOptions,
      ),
      (error: unknown) =>
        error instanceof EnvelopeMutationError && error.statusCode === 409,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MANAGER_APPROVAL;
    } else {
      process.env.MANAGER_APPROVAL = previous;
    }
  }

  const after = await database.query<{ email: string }>(
    `select email from signers where id = $1`,
    [approver.rows[0]!.id],
  );

  assert.equal(after.rows[0]?.email, manager);
});

test("a send is refused, not quietly relaxed, when the Google signing setting cannot be read", async () => {
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);
  // Only the stored integration settings cannot be read.
  const failing = new Proxy(database, {
    get(target, property) {
      if (property === "query") {
        return (text: unknown, ...rest: unknown[]) =>
          typeof text === "string" && /integration_settings/.test(text)
            ? Promise.reject(new Error("connection refused"))
            : (target.query as unknown as (...args: unknown[]) => unknown).call(
                target,
                text,
                ...rest,
              );
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const replaced = replaceDbPoolForTests(failing);

  invalidateIntegrationSettingsCache();

  const originalError = console.error;

  console.error = () => undefined;

  try {
    await assert.rejects(
      sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
        database,
        managerPolicy: { mode: "off", source: "default", teamIds: [] },
      }),
      (error: unknown) =>
        error instanceof EnvelopeMutationError && error.statusCode === 503,
    );
  } finally {
    console.error = originalError;
    invalidateIntegrationSettingsCache();
    replaceDbPoolForTests(replaced ?? database);
  }

  assert.equal(await statusOf(draft.envelopeId), "draft");
});

test("correcting a sent approver asks the directory before any row is locked", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const draft = await createDraft([
    { email: manager, role: "approver", step: 1 },
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 2 },
  ]);
  const base = directoryFor(draft.senderEmail, manager);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
    database,
    directory: base,
    managerPolicy: requireForEveryone,
  });

  const approver = await database.query<{ id: string }>(
    `select id from signers where envelope_id = $1 and role = 'approver'`,
    [draft.envelopeId],
  );
  let askedWhileLocked = 0;
  let asked = 0;
  const directory: DirectoryClient = {
    ...base,
    getUser: async (email) => {
      asked += 1;

      // A row another transaction holds is skipped by SKIP LOCKED. This
      // proves the defect on Postgres only: SQLite treats a locking read
      // outside a transaction as a plain read, so it cannot see the lock.
      const free = await Promise.race([
        database.query(
          `select id from envelopes where id = $1 for update skip locked`,
          [draft.envelopeId],
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);

      if (free === null || free.rows.length === 0) {
        askedWhileLocked += 1;
      }

      return base.getUser(email);
    },
  };
  const correctionOptions = { database, directory };
  const previous = process.env.MANAGER_APPROVAL;

  process.env.MANAGER_APPROVAL = "require";

  try {
    await assert.rejects(
      correctSentEnvelopeSigner(
        draft.userId,
        draft.envelopeId,
        approver.rows[0]!.id,
        { email: `mine-${randomUUID()}@example.test` },
        { senderEmail: draft.senderEmail, senderName: "Sam Sender" },
        correctionOptions,
      ),
      (error: unknown) => error instanceof EnvelopeMutationError,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MANAGER_APPROVAL;
    } else {
      process.env.MANAGER_APPROVAL = previous;
    }
  }

  assert.ok(asked > 0);
  assert.equal(askedWhileLocked, 0);
});

/** Stores the manager rule as an administrator's saved setting. */
async function storeManagerPolicy(mode: "require" | "suggest") {
  await database.query(
    `
      insert into public.integration_settings (key, value, secret, updated_at)
      values ('people.managerPolicy', $1, false, $2)
      on conflict (key) do update set value = excluded.value
    `,
    [mode, Math.floor(Date.now() / 1000)],
  );
}

async function clearManagerPolicy() {
  await database.query(
    `delete from public.integration_settings where key = 'people.managerPolicy'`,
  );
}

test("in require mode the review page says why the send is blocked", async () => {
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);

  await storeManagerPolicy("require");

  try {
    // No directory is turned on in the test environment, so the manager
    // cannot be found, and in require mode that blocks the send.
    const review = await getReviewEnvelopeDataForUser(
      draft.userId,
      draft.envelopeId,
      database,
    );

    assert.ok(review);
    assert.equal(review.canSend, false);
    assert.match(
      review.disabledReason ?? "",
      /requires your manager to approve first/,
    );
    assert.match(review.disabledReason ?? "", /directory is not turned on/);
    assert.equal(review.managerSuggestion, null);
  } finally {
    await clearManagerPolicy();
  }
});

test("in suggest mode the review page offers the manager without blocking the send", async () => {
  const draft = await createDraft([
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 1 },
  ]);

  await storeManagerPolicy("suggest");

  try {
    const review = await getReviewEnvelopeDataForUser(
      draft.userId,
      draft.envelopeId,
      database,
    );

    assert.ok(review);
    assert.equal(review.canSend, true);
    assert.equal(review.disabledReason, null);
    assert.match(review.managerSuggestion ?? "", /directory is not turned on/);
  } finally {
    await clearManagerPolicy();
  }
});

/** Corrects the approver at `step`'s address with require mode on. */
async function correctApproverUnderRequire(
  draft: { envelopeId: string; senderEmail: string; userId: string },
  approverEmail: string,
  directory: DirectoryClient,
) {
  const approver = await database.query<{ id: string }>(
    `select id from signers where envelope_id = $1 and lower(email) = $2`,
    [draft.envelopeId, approverEmail.toLowerCase()],
  );
  const previous = process.env.MANAGER_APPROVAL;

  process.env.MANAGER_APPROVAL = "require";

  try {
    await correctSentEnvelopeSigner(
      draft.userId,
      draft.envelopeId,
      approver.rows[0]!.id,
      { email: `fixed-${randomUUID()}@example.test` },
      { senderEmail: draft.senderEmail, senderName: "Sam Sender" },
      { database, directory },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MANAGER_APPROVAL;
    } else {
      process.env.MANAGER_APPROVAL = previous;
    }
  }

  return approver.rows[0]!.id;
}

test("correcting an approver on an envelope the rule did not cover when it was sent is allowed", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const other = `other-${randomUUID()}@example.test`;
  // Sent while the rule was off, so the manager is not in the order.
  const draft = await createDraft([
    { email: other, role: "approver", step: 1 },
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 2 },
  ]);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
    database,
    directory: directoryFor(draft.senderEmail, manager),
    managerPolicy: { mode: "off", source: "default", teamIds: [] },
  });

  const signerId = await correctApproverUnderRequire(
    draft,
    other,
    directoryFor(draft.senderEmail, manager),
  );
  const after = await database.query<{ email: string }>(
    `select email from signers where id = $1`,
    [signerId],
  );

  assert.match(after.rows[0]!.email, /^fixed-/);
});

test("correcting an approver still works when the directory cannot be asked", async () => {
  const manager = `boss-${randomUUID()}@example.test`;
  const draft = await createDraft([
    { email: manager, role: "approver", step: 1 },
    { email: `client-${randomUUID()}@example.test`, role: "signer", step: 2 },
  ]);

  await sendDraftEnvelope(draft.userId, draft.envelopeId, send, {
    database,
    directory: directoryFor(draft.senderEmail, manager),
    managerPolicy: requireForEveryone,
  });

  const unreachable: DirectoryClient = {
    ...directoryFor(draft.senderEmail, manager),
    getUser: async () => {
      throw new Error("directory unreachable");
    },
  };
  const signerId = await correctApproverUnderRequire(
    draft,
    manager,
    unreachable,
  );
  const after = await database.query<{ email: string }>(
    `select email from signers where id = $1`,
    [signerId],
  );

  assert.match(after.rows[0]!.email, /^fixed-/);
});
