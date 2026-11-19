import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type {
  FileConnectionRepository,
  StoredFileConnection,
} from "../../../file-connections.ts";
import { FilesConnectionError } from "../../../types.ts";
import { createGoogleCredentials, GOOGLE_SCOPES } from "../credentials.ts";
import { googleWorkspace } from "../index.ts";
import { GOOGLE_APPS } from "../test-support/fake-drive.ts";
import {
  createFakeServiceAccountKey,
  FAKE_GOOGLE_CLIENT,
  startFakeGoogle,
  type FakeGoogle,
} from "../test-support/fake-google.ts";
import { uploadDriveFile } from "./drive-api.ts";
import { createGoogleFiles, isGoogleFilesSetUp } from "./drive-files.ts";
import { createDriveTokenStore } from "./drive-tokens.ts";

// Google Drive as the workspace's files, against the fake Google server:
// a person's picked Google Doc comes back as a PDF, and executed copies go
// into a Shared Drive once, however often the export is tried.

const key = createFakeServiceAccountKey();
const SAM = "sam@acme.example";
const SHARED_DRIVE = "0AFakeLegal";
let google: FakeGoogle;
let env: Record<string, string>;

before(async () => {
  google = await startFakeGoogle({
    drives: [{ id: SHARED_DRIVE, name: "Legal" }],
    serviceAccounts: [key],
    users: [{ email: SAM, familyName: "Sender", givenName: "Sam" }],
  });
  // Drive calls find the fake through these, as the app's would.
  Object.assign(process.env, google.env);
  env = {
    ...google.env,
    BETTER_AUTH_SECRET: "s".repeat(40),
    GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT.id,
    GOOGLE_OAUTH_CLIENT_SECRET: FAKE_GOOGLE_CLIENT.secret,
    GOOGLE_PICKER_API_KEY: "AIzaFakePickerKey1234567890",
    GOOGLE_PICKER_APP_ID: "123456789012",
  };
});

after(async () => {
  await google.close();
});

beforeEach(() => {
  globalThis.__signudocDriveAccessTokens = undefined;
  globalThis.__signudocDriveRefreshes = undefined;
});

function memoryRepository(): FileConnectionRepository {
  const rows = new Map<string, StoredFileConnection>();

  return {
    async delete(userId) {
      const row = rows.get(userId) ?? null;

      rows.delete(userId);

      return row;
    },
    async read(userId) {
      return rows.get(userId) ?? null;
    },
    async write(connection) {
      rows.set(connection.userId, connection);
    },
  };
}

function filesFor(repository = memoryRepository()) {
  return createGoogleFiles({
    credentials: () =>
      createGoogleCredentials({
        env: { ...google.env, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key) },
      }),
    env,
    stored: { "files.exportDestination": SHARED_DRIVE },
    tokens: createDriveTokenStore({ env, repository }),
  });
}

test("files are offered once a Shared Drive or the Picker is set up", () => {
  assert.equal(isGoogleFilesSetUp({}, {}), false);
  assert.equal(
    isGoogleFilesSetUp({ "files.exportDestination": SHARED_DRIVE }, {}),
    true,
  );
  // The Picker without an OAuth client is not enough.
  assert.equal(
    isGoogleFilesSetUp(
      { "google.pickerApiKey": "key", "google.pickerAppId": "1" },
      {},
    ),
    false,
  );
  assert.equal(isGoogleFilesSetUp({}, env), true);
  assert.equal(googleWorkspace.files?.({ env: {}, settings: {} }), null);
  assert.equal(googleWorkspace.files?.({ env, settings: {} })?.canImport, true);
});

test("without a connection there is no picker, and connecting is offered", async () => {
  const files = filesFor();

  await assert.rejects(
    files.pickerConfig("user-1"),
    (error) =>
      error instanceof FilesConnectionError && error.code === "not_connected",
  );

  const { secret, url } = await files.startConnect({
    email: SAM,
    redirectUri: "https://sign.example.test/api/workspace/files/callback",
    state: "state-1",
  });
  const address = new URL(url);

  assert.ok(secret.length >= 43);
  assert.equal(address.searchParams.get("client_id"), FAKE_GOOGLE_CLIENT.id);
  assert.equal(address.searchParams.get("login_hint"), SAM);
  assert.equal(
    address.searchParams.get("code_challenge"),
    createHash("sha256").update(secret).digest("base64url"),
  );
});

test("a picked Google Doc is read with the person's own token and comes back as a PDF", async () => {
  const repository = memoryRepository();
  const files = filesFor(repository);
  const store = createDriveTokenStore({ env, repository });

  await store.save({
    accountEmail: SAM,
    accountId: "sam",
    refreshToken: google.issueRefreshToken({
      clientId: FAKE_GOOGLE_CLIENT.id,
      scopes: [GOOGLE_SCOPES.driveFile],
      user: SAM,
    }),
    scope: GOOGLE_SCOPES.driveFile,
    userId: "user-1",
  });

  const doc = await uploadDriveFile<{ id: string }>({
    accessToken: google.issueAccessToken({
      scopes: [GOOGLE_SCOPES.driveFile],
      user: SAM,
    }),
    bytes: new TextEncoder().encode("Offer letter"),
    contentType: "text/plain",
    metadata: { mimeType: GOOGLE_APPS.document, name: "Offer letter" },
  });
  const picker = await files.pickerConfig("user-1");

  assert.equal(picker.provider, "google");
  assert.equal(picker.appId, "123456789012");
  assert.ok(picker.mimeTypes.includes(GOOGLE_APPS.document));

  const imported = await files.importFile({
    fileId: doc.id,
    userId: "user-1",
  });

  assert.equal(imported.fileName, "Offer letter.pdf");
  assert.equal(Buffer.from(imported.bytes).subarray(0, 5).toString(), "%PDF-");
  assert.equal(imported.sourceFileId, doc.id);
  assert.equal((await files.connection("user-1"))?.account, SAM);
});

test("executed copies go into the Shared Drive once, however often they are tried", async () => {
  const files = filesFor();
  const bytes = new TextEncoder().encode("%PDF-1.4 signed");
  const request = {
    copies: [
      {
        bytes,
        fileName: "Lease.pdf",
        kind: "signed" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    destination: SHARED_DRIVE,
    envelopeId: "env-1",
    folderPath: ["2026", "Leases"],
    metadata: {},
  };
  const first = await files.exportExecutedCopies(request);
  const again = await files.exportExecutedCopies(request);

  assert.equal(first.metadataProblem, null);
  assert.deepEqual(again.files, first.files);
  assert.equal(
    google.files().filter((file) => file.name === "Lease.pdf").length,
    1,
  );
});

test("the files check reports the Shared Drive and the Picker", async () => {
  const setup = googleWorkspace.setup({
    env: { ...env, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key) },
    settings: { "files.exportDestination": SHARED_DRIVE },
  });
  const checks = await setup.check("files");

  assert.deepEqual(
    checks.map((check) => [check.id, check.ok]),
    [
      ["files.picker", true],
      ["files.destination", true],
    ],
  );
});
