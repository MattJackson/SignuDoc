import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import type { GoogleSigningPolicy } from "./google-signing.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningMutationError,
  SigningVerificationRequiredError,
  submitSigningForToken,
  verifySignerCheck,
} from "./signing.ts";

// Employees signing with Google, against a real Postgres: a signer who must
// confirm who they are with Google gets in only on a current Google
// sign-in session of their own address, the check is recorded, it is
// named on the certificate, and nothing the sender asked for is dropped.
// Signers outside the Workspace are never asked. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
const WORKSPACE = "corp.example";
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const requirePolicy: GoogleSigningPolicy = {
  available: true,
  domains: [WORKSPACE],
  mode: "require",
  source: "settings",
  ssoIsGoogle: true,
};

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-google-signing-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(workDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: workDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(workDir, { force: true, recursive: true });
});

async function createUser(email: string) {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, 'Person', $2, true, 'user')
    `,
    [id, email],
  );

  return id;
}

/** A session of this account, as a sign-in would leave it. */
async function createSession(
  userId: string,
  signInMethod: "sso" | null,
): Promise<string> {
  const token = randomBytes(24).toString("hex");

  await database.query(
    `
      insert into public.session (id, "expiresAt", token, "userId", sign_in_method)
      values ($1, now() + interval '1 day', $2, $3, $4)
    `,
    [randomUUID(), token, userId, signInMethod],
  );

  return token;
}

/** An envelope out for signature to one waiting signer. */
async function createEnvelope(
  signerEmail: string,
  {
    requireEmailCode = false,
    requireGoogle = true,
  }: { requireEmailCode?: boolean; requireGoogle?: boolean } = {},
) {
  const senderId = await createUser(`sender-${randomUUID()}@${WORKSPACE}`);
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const fieldId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);

  const bytes = await pdf.save();
  const key = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: bytes,
    contentType: "application/pdf",
    key,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Contract', 'sent', $3, 'contract.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      senderId,
      key,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      now,
      now + 30 * DAY,
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });

  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, signing_step, status,
        signing_token_hash, signing_token_expires_at, turn_started_at,
        last_notified_at, require_google_sign_in, require_email_code
      ) values ($1, $2, 'Pat', $3, 1, 1, 'notified', $4, $5, $6, $6, $7, $8)
    `,
    [
      signerId,
      envelopeId,
      signerEmail,
      link.tokenHash,
      link.exp,
      now,
      requireGoogle,
      requireEmailCode,
    ],
  );
  await database.query(
    `
      insert into fields (id, envelope_id, signer_id, type, page, x, y, width, height)
      values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.05)
    `,
    [fieldId, envelopeId, signerId],
  );

  return { envelopeId, fieldId, signerId, token: link.token };
}

async function verificationEvents(envelopeId: string) {
  const result = await database.query<{
    event: string;
    metadata: Record<string, unknown>;
  }>(
    `
      select event, metadata from audit_events
      where envelope_id = $1 and event in ('verified', 'verification_failed')
      order by sequence
    `,
    [envelopeId],
  );

  return result.rows;
}

function checkGoogle(token: string, sessionToken: string | null) {
  return verifySignerCheck(
    token,
    { method: "google" },
    {
      database,
      googleSigningPolicy: requirePolicy,
      signedInSessionToken: sessionToken,
    },
  );
}

test("a required Google check keeps the document closed until it is passed", async () => {
  const email = `pat-${randomUUID()}@${WORKSPACE}`;
  const envelope = await createEnvelope(email);

  await assert.rejects(
    getSigningPayloadForToken(envelope.token, { database }),
    (error: unknown) =>
      error instanceof SigningVerificationRequiredError &&
      error.details.pending.join() === "google",
  );
});

test("only a Google session of the very address the document was sent to passes", async () => {
  const email = `pat-${randomUUID()}@${WORKSPACE}`;
  const envelope = await createEnvelope(email);
  const pat = await createUser(email);
  const someoneElse = await createUser(`kim-${randomUUID()}@${WORKSPACE}`);

  // Not signed in at all.
  await assert.rejects(
    checkGoogle(envelope.token, null),
    (error: unknown) => error instanceof SigningMutationError,
  );
  // Signed in as Pat, but with a password.
  await assert.rejects(
    checkGoogle(envelope.token, await createSession(pat, null)),
    (error: unknown) =>
      error instanceof SigningMutationError &&
      /signed in with a password/.test(error.message),
  );
  // Signed in with Google, as someone else.
  await assert.rejects(
    checkGoogle(envelope.token, await createSession(someoneElse, "sso")),
    (error: unknown) =>
      error instanceof SigningMutationError &&
      /but this document was sent to/.test(error.message),
  );
  // A session that has ended.
  const ended = await createSession(pat, "sso");

  await database.query(
    `update public.session set "expiresAt" = now() - interval '1 minute' where token = $1`,
    [ended],
  );
  await assert.rejects(
    checkGoogle(envelope.token, ended),
    (error: unknown) => error instanceof SigningMutationError,
  );

  const passed = await checkGoogle(
    envelope.token,
    await createSession(pat, "sso"),
  );

  assert.deepEqual(passed, ["google"]);

  const events = await verificationEvents(envelope.envelopeId);

  assert.deepEqual(
    events.map((event) => [event.event, event.metadata.reason ?? null]),
    [
      ["verification_failed", "not_signed_in"],
      ["verification_failed", "not_google_session"],
      ["verification_failed", "different_account"],
      ["verification_failed", "not_signed_in"],
      ["verified", null],
    ],
  );
  assert.equal(events.at(-1)?.metadata.method, "google");
  assert.equal(events.at(-1)?.metadata.accountUserId, pat);
});

test("a Google session no longer counts once the site's sign-in is not Google", async () => {
  const email = `pat-${randomUUID()}@${WORKSPACE}`;
  const envelope = await createEnvelope(email);
  const pat = await createUser(email);

  await assert.rejects(
    verifySignerCheck(
      envelope.token,
      { method: "google" },
      {
        database,
        googleSigningPolicy: { ...requirePolicy, ssoIsGoogle: false },
        signedInSessionToken: await createSession(pat, "sso"),
      },
    ),
    (error: unknown) =>
      error instanceof SigningMutationError &&
      /not set up on this site/.test(error.message),
  );

  const events = await verificationEvents(envelope.envelopeId);

  assert.deepEqual(
    events.map((event) => [event.event, event.metadata.reason ?? null]),
    [["verification_failed", "google_not_configured"]],
  );
  await assert.rejects(
    getSigningPayloadForToken(envelope.token, { database }),
    (error: unknown) =>
      error instanceof SigningVerificationRequiredError &&
      error.details.pending.join() === "google",
  );
});

test("the Google sign-in is recorded with the signature and named on the certificate", async () => {
  const email = `pat-${randomUUID()}@${WORKSPACE}`;
  const envelope = await createEnvelope(email);
  const pat = await createUser(email);
  const verifiedMethods = await checkGoogle(
    envelope.token,
    await createSession(pat, "sso"),
  );
  const payload = await getSigningPayloadForToken(envelope.token, {
    database,
    verifiedMethods,
  });

  assert.deepEqual(payload.googleSignIn, { confirmed: true, required: true });

  await recordSignerConsent(
    envelope.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database, verifiedMethods },
  );
  await submitSigningForToken(
    envelope.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: envelope.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database, verifiedMethods },
  );

  const signed = await database.query<{ metadata: Record<string, unknown> }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'signed'`,
    [envelope.envelopeId],
  );

  assert.deepEqual(signed.rows[0]?.metadata.authMethods, ["google"]);

  const stored = await database.query<{ evidence_key: string }>(
    `select evidence_key from envelopes where id = $1`,
    [envelope.envelopeId],
  );
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(
      (await storageService.getObject(stored.rows[0]!.evidence_key)).body,
    ),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  let text = "";

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();

    text += content.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ");
  }

  await document.destroy();

  assert.match(
    text.replace(/\s+/g, " "),
    /identity confirmed by Google Workspace sign-in/,
  );
});

test("the Google check never stands in for an emailed code the sender asked for", async () => {
  const email = `pat-${randomUUID()}@${WORKSPACE}`;
  const envelope = await createEnvelope(email, { requireEmailCode: true });
  const pat = await createUser(email);
  const verifiedMethods = await checkGoogle(
    envelope.token,
    await createSession(pat, "sso"),
  );

  await assert.rejects(
    getSigningPayloadForToken(envelope.token, { database, verifiedMethods }),
    (error: unknown) =>
      error instanceof SigningVerificationRequiredError &&
      error.details.pending.join() === "email_code",
  );
});

test("someone outside the Workspace is never asked, and cannot take the check", async () => {
  const email = `client-${randomUUID()}@customer.test`;
  const envelope = await createEnvelope(email, { requireGoogle: false });
  const payload = await getSigningPayloadForToken(envelope.token, {
    database,
  });

  assert.equal(payload.googleSignIn ?? null, null);
  await assert.rejects(
    checkGoogle(envelope.token, null),
    (error: unknown) =>
      error instanceof SigningMutationError && /not needed/.test(error.message),
  );
});

test("sending in require mode asks employees only, and remembers it on each signer", async () => {
  const senderId = await createUser(`sender-${randomUUID()}@${WORKSPACE}`);
  const envelopeId = randomUUID();
  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);

  const bytes = await pdf.save();
  const key = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: bytes,
    contentType: "application/pdf",
    key,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Contract', 'draft', $3, 'contract.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      senderId,
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
    senderId,
    envelopeId,
    {
      signers: [
        { email: `pat-${randomUUID()}@${WORKSPACE}`, name: "Pat" },
        { email: `client-${randomUUID()}@customer.test`, name: "Cal" },
      ],
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    senderId,
    envelopeId,
    {
      fields: saved.signers.map((signer, index) => ({
        height: 0.05,
        page: 1,
        required: true,
        signerId: signer.id,
        type: "signature" as const,
        width: 0.2,
        x: 0.1,
        y: 0.1 + index * 0.1,
      })),
    },
    database,
  );
  await sendDraftEnvelope(
    senderId,
    envelopeId,
    { senderEmail: "sam@corp.example", senderName: "Sam Sender" },
    { database, googleSigningPolicy: requirePolicy },
  );

  const flags = await database.query<{ email: string; required: boolean }>(
    `
      select email, require_google_sign_in as required from signers
      where envelope_id = $1 order by sign_order
    `,
    [envelopeId],
  );

  assert.deepEqual(
    flags.rows.map((row) => row.required),
    [true, false],
  );
});
