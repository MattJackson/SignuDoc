import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AuditExportError, exportEnvelopeAuditCsv } from "./audit-export.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { DownloadAccessError, getSenderEnvelopeDownload } from "./downloads.ts";
import { deleteFinishedEnvelope } from "./envelope-deletion.ts";
import {
  changeEnvelopeDeadline,
  changeEnvelopeReminders,
  copyEnvelopeToDraft,
  correctSentEnvelopeSigner,
  deleteDraftEnvelope,
  EnvelopeDocumentAccessError,
  EnvelopeMutationError,
  getDraftEnvelopeDocumentForUser,
  getDraftSignerStepDataForUser,
  getEnvelopeDetailDataForUser,
  getEnvelopeThumbnailForUser,
  getPrepareEnvelopeDataForUser,
  getReviewEnvelopeDataForUser,
  listEnvelopesForUser,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
  voidSentEnvelope,
} from "./envelopes.ts";
import { type EnvelopeScope } from "./envelope-access.ts";
import { ReminderMutationError, sendManualEnvelopeNudge } from "./reminders.ts";
import { buildEnvelopeThumbnailKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamsForUser,
  removeTeamMember,
  TeamError,
  updateTeam,
} from "./teams.ts";
import { saveEnvelopeAsTemplate, TemplateError } from "./templates.ts";

// Who can see and who can change an envelope once teams exist, against a
// real Postgres. The sender sees and changes their own. Someone on a team
// with them, and an administrator, see a sent envelope but change nothing,
// and nobody but the sender sees a draft. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];
const createdTeams: string[] = [];

type Account = { email: string; id: string };

let owner: Account;
let teammate: Account;
let outsider: Account;
// On a team of their own, which is not the sender's.
let otherTeam: Account;
let admin: Account;
let teamId: string;
// A word only these envelopes have in their titles, so the lists can be
// narrowed to them whatever else the shared test database holds.
const marker = `team${randomUUID().slice(0, 8)}`;
const envelopes: { completed: string; draft: string; sent: string } = {
  completed: "",
  draft: "",
  sent: "",
};
let sentSignerId: string;

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
  status: "completed" | "draft" | "sent",
): Promise<{ envelopeId: string; signerId: string }> {
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sourcePdfKey = `test/${envelopeId}.pdf`;
  const signedPdfKey = `test/${envelopeId}-signed.pdf`;

  await storageService.putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  if (status === "completed") {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70, 45]),
      contentType: "application/pdf",
      key: signedPdfKey,
    });
  }

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, completed_at, signed_pdf_key, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, 'contract.pdf', 4, 1, $6, $7, $8, $9, $10, $11, $11
      )
    `,
    [
      envelopeId,
      ownerId,
      `Contract ${marker} ${status}`,
      status,
      sourcePdfKey,
      "a".repeat(64),
      status === "draft" ? null : now,
      status === "sent" ? now + 30 * DAY : null,
      status === "completed" ? now : null,
      status === "completed" ? signedPdfKey : null,
      // Ahead of anything else in the shared database, so these come first.
      now + 365 * DAY,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, signing_step, status,
        signed_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 1, $4, $5)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@example.test`,
      status === "completed"
        ? "signed"
        : status === "sent"
          ? "notified"
          : "pending",
      status === "completed" ? now : null,
    ],
  );

  return { envelopeId, signerId };
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-teams-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(workDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: workDir,
  });
  storageService = createStorageService();

  owner = await createAccount("user");
  teammate = await createAccount("user");
  outsider = await createAccount("user");
  otherTeam = await createAccount("user");
  admin = await createAccount("admin");

  envelopes.draft = (await createEnvelope(owner.id, "draft")).envelopeId;

  const sent = await createEnvelope(owner.id, "sent");

  envelopes.sent = sent.envelopeId;
  sentSignerId = sent.signerId;
  envelopes.completed = (
    await createEnvelope(owner.id, "completed")
  ).envelopeId;

  const team = await createTeam(
    { email: admin.email, userId: admin.id },
    { name: `Sales ${marker}` },
    database,
  );

  teamId = team.id;
  createdTeams.push(teamId);
  await addTeamMember(
    { email: admin.email, userId: admin.id },
    teamId,
    { email: owner.email },
    database,
  );
  await addTeamMember(
    { email: admin.email, userId: admin.id },
    teamId,
    { email: teammate.email },
    database,
  );

  const legal = await createTeam(
    { email: admin.email, userId: admin.id },
    { name: `Support ${marker}` },
    database,
  );

  createdTeams.push(legal.id);
  await addTeamMember(
    { email: admin.email, userId: admin.id },
    legal.id,
    { email: otherTeam.email },
    database,
  );
});

after(async () => {
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(workDir, { force: true, recursive: true });
});

async function listed(viewer: Account, scope: EnvelopeScope) {
  const items = await listEnvelopesForUser(
    viewer.id,
    { limit: 100, scope, search: marker },
    database,
  );

  return items.map((item) => item.id).sort();
}

function sorted(...ids: string[]) {
  return [...ids].sort();
}

const refusedAsNotFound = (error: unknown) =>
  (error instanceof EnvelopeMutationError ||
    error instanceof EnvelopeDocumentAccessError ||
    error instanceof DownloadAccessError ||
    error instanceof AuditExportError ||
    error instanceof ReminderMutationError ||
    error instanceof TemplateError) &&
  error.statusCode === 404;

test("each scope lists what its viewer may see, and drafts only for their sender", async () => {
  assert.deepEqual(
    await listed(owner, "mine"),
    sorted(envelopes.draft, envelopes.sent, envelopes.completed),
  );
  assert.deepEqual(
    await listed(owner, "team"),
    sorted(envelopes.draft, envelopes.sent, envelopes.completed),
  );
  assert.deepEqual(await listed(teammate, "mine"), []);
  assert.deepEqual(
    await listed(teammate, "team"),
    sorted(envelopes.sent, envelopes.completed),
  );
  assert.deepEqual(await listed(outsider, "team"), []);
  assert.deepEqual(await listed(outsider, "all"), []);
  assert.deepEqual(await listed(otherTeam, "team"), []);
  assert.deepEqual(await listed(otherTeam, "all"), []);
  assert.deepEqual(await listed(admin, "mine"), []);
  assert.deepEqual(await listed(admin, "team"), []);
  assert.deepEqual(
    await listed(admin, "all"),
    sorted(envelopes.sent, envelopes.completed),
  );

  const teamItems = await listEnvelopesForUser(
    teammate.id,
    { scope: "team", search: marker },
    database,
  );

  assert.ok(teamItems.every((item) => item.canManage === false));
  assert.ok(teamItems.every((item) => item.sentByLabel?.includes(owner.email)));
});

test("the envelope page shows a sent envelope to a teammate and an administrator, read-only", async () => {
  const mine = await getEnvelopeDetailDataForUser(
    owner.id,
    envelopes.sent,
    database,
  );

  assert.equal(mine?.canManage, true);
  assert.equal(mine?.sentByLabel, null);

  for (const viewer of [teammate, admin]) {
    const detail = await getEnvelopeDetailDataForUser(
      viewer.id,
      envelopes.sent,
      database,
    );

    assert.equal(detail?.canManage, false);
    assert.match(detail?.sentByLabel ?? "", new RegExp(owner.email));
    assert.equal(
      await getEnvelopeDetailDataForUser(viewer.id, envelopes.draft, database),
      null,
    );
  }

  assert.equal(
    await getEnvelopeDetailDataForUser(outsider.id, envelopes.sent, database),
    null,
  );
});

test("finished files, the audit trail and the thumbnail follow the same rule", async () => {
  for (const viewer of [owner, teammate, admin]) {
    const download = await getSenderEnvelopeDownload(
      viewer.id,
      envelopes.completed,
      "signed",
      { database },
    );

    assert.equal(download.envelopeId, envelopes.completed);

    const csv = await exportEnvelopeAuditCsv(
      viewer.id,
      envelopes.sent,
      database,
    );

    assert.ok(csv.fileName.length > 0);
  }

  await assert.rejects(
    getSenderEnvelopeDownload(outsider.id, envelopes.completed, "signed", {
      database,
    }),
    refusedAsNotFound,
  );
  await assert.rejects(
    exportEnvelopeAuditCsv(outsider.id, envelopes.sent, database),
    refusedAsNotFound,
  );
  await assert.rejects(
    exportEnvelopeAuditCsv(teammate.id, envelopes.draft, database),
    refusedAsNotFound,
  );

  // The picture is stored under its sender, and shown to the team.
  const sourcePdfKey = `test/${envelopes.sent}.pdf`;

  await storageService.putObject({
    body: new Uint8Array([255, 216, 255]),
    contentType: "image/jpeg",
    key: buildEnvelopeThumbnailKey({
      envelopeId: envelopes.sent,
      sourcePdfKey,
      userId: owner.id,
    }),
  });

  const thumbnail = await getEnvelopeThumbnailForUser(
    teammate.id,
    envelopes.sent,
    { database, storageService },
  );

  assert.equal(thumbnail.isNotModified, false);

  if (!thumbnail.isNotModified) {
    await thumbnail.picture.stream.cancel();
  }

  await assert.rejects(
    getEnvelopeThumbnailForUser(outsider.id, envelopes.sent, {
      database,
      storageService,
    }),
    (error: unknown) =>
      error instanceof EnvelopeDocumentAccessError &&
      error.message === "Envelope not found.",
  );
});

test("nobody but the sender changes an envelope", async () => {
  for (const viewer of [teammate, admin, outsider]) {
    const sender = { senderEmail: viewer.email, senderName: "Someone" };

    await assert.rejects(
      voidSentEnvelope(viewer.id, envelopes.sent, sender, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      changeEnvelopeDeadline(
        viewer.id,
        envelopes.sent,
        { expiresInDays: 7, senderEmail: viewer.email },
        { database },
      ),
      refusedAsNotFound,
    );
    await assert.rejects(
      changeEnvelopeReminders(viewer.id, envelopes.sent, 3, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      sendManualEnvelopeNudge(viewer.id, envelopes.sent, sender, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      correctSentEnvelopeSigner(
        viewer.id,
        envelopes.sent,
        sentSignerId,
        { name: "Someone Else" },
        sender,
        { database },
      ),
      refusedAsNotFound,
    );
    await assert.rejects(
      copyEnvelopeToDraft(viewer.id, envelopes.sent, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      saveEnvelopeAsTemplate(
        viewer.id,
        envelopes.sent,
        { name: "Mine now" },
        { database },
      ),
      refusedAsNotFound,
    );
    await assert.rejects(
      getDraftEnvelopeDocumentForUser(viewer.id, envelopes.sent, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      replaceDraftEnvelopeSigners(
        viewer.id,
        envelopes.draft,
        { signers: [{ email: "x@example.test", name: "X" }] },
        database,
      ),
      refusedAsNotFound,
    );
    await assert.rejects(
      sendDraftEnvelope(viewer.id, envelopes.draft, sender, { database }),
      refusedAsNotFound,
    );
    await assert.rejects(
      deleteDraftEnvelope(viewer.id, envelopes.draft, { database }),
      refusedAsNotFound,
    );
    assert.equal(
      await getDraftSignerStepDataForUser(viewer.id, envelopes.draft, database),
      null,
    );
    assert.equal(
      await getPrepareEnvelopeDataForUser(viewer.id, envelopes.draft, {
        database,
      }),
      null,
    );
    assert.equal(
      await getReviewEnvelopeDataForUser(viewer.id, envelopes.draft, database),
      null,
    );
  }

  // An administrator still deletes only finished envelopes of their own.
  await assert.rejects(
    deleteFinishedEnvelope(
      envelopes.completed,
      { actor: { email: admin.email, userId: admin.id } },
      { database, storageService },
    ),
    refusedAsNotFound,
  );

  const state = await database.query<{ id: string; status: string }>(
    `select id, status from envelopes where id = any($1)`,
    [[envelopes.draft, envelopes.sent, envelopes.completed]],
  );

  assert.deepEqual(
    Object.fromEntries(state.rows.map((row) => [row.id, row.status])),
    {
      [envelopes.completed]: "completed",
      [envelopes.draft]: "draft",
      [envelopes.sent]: "sent",
    },
  );

  const signer = await database.query<{ name: string; status: string }>(
    `select name, status from signers where id = $1`,
    [sentSignerId],
  );

  assert.deepEqual(signer.rows[0], {
    name: "Riley Recipient",
    status: "notified",
  });
});

test("only an administrator changes teams, and every change is in the install's audit trail", async () => {
  await assert.rejects(
    createTeam(
      { email: owner.email, userId: owner.id },
      { name: `Rogue ${marker}` },
      database,
    ),
    (error: unknown) => error instanceof TeamError && error.statusCode === 403,
  );
  await assert.rejects(
    createTeam(
      { email: admin.email, userId: admin.id },
      { name: `sales ${marker}` },
      database,
    ),
    (error: unknown) => error instanceof TeamError && error.statusCode === 409,
  );

  const actor = { email: admin.email, userId: admin.id };
  const second = await createTeam(
    actor,
    {
      googleGroupEmail: `legal-${marker}@example.test`,
      name: `Legal ${marker}`,
    },
    database,
  );

  createdTeams.push(second.id);
  await updateTeam(
    actor,
    second.id,
    { name: `Legal team ${marker}` },
    database,
  );
  await addTeamMember(actor, second.id, { email: outsider.email }, database);
  assert.deepEqual(
    (await listTeamsForUser(outsider.id, database)).map((team) => team.id),
    [second.id],
  );
  await removeTeamMember(actor, second.id, outsider.id, database);
  await deleteTeam(actor, second.id, database);

  const events = await database.query<{ event: string }>(
    `
      select event from system_audit_events
      where metadata->>'teamId' = $1
      order by sequence
    `,
    [second.id],
  );

  assert.deepEqual(
    events.rows.map((row) => row.event),
    [
      "team_created",
      "team_updated",
      "team_member_added",
      "team_member_removed",
      "team_deleted",
    ],
  );
});

test("taking someone off the team takes away what they could see", async () => {
  const actor = { email: admin.email, userId: admin.id };

  await removeTeamMember(actor, teamId, teammate.id, database);

  try {
    assert.deepEqual(await listed(teammate, "team"), []);
    assert.equal(
      await getEnvelopeDetailDataForUser(teammate.id, envelopes.sent, database),
      null,
    );
  } finally {
    await addTeamMember(actor, teamId, { email: teammate.email }, database);
  }
});

test("someone on another team sees none of this team's envelopes", async () => {
  assert.deepEqual(await listed(otherTeam, "mine"), []);
  assert.deepEqual(await listed(otherTeam, "team"), []);
  assert.deepEqual(await listed(otherTeam, "all"), []);

  for (const envelopeId of [envelopes.sent, envelopes.completed]) {
    assert.equal(
      await getEnvelopeDetailDataForUser(otherTeam.id, envelopeId, database),
      null,
    );
  }

  await assert.rejects(
    getSenderEnvelopeDownload(otherTeam.id, envelopes.completed, "signed", {
      database,
    }),
    refusedAsNotFound,
  );
  await assert.rejects(
    exportEnvelopeAuditCsv(otherTeam.id, envelopes.sent, database),
    refusedAsNotFound,
  );
});
