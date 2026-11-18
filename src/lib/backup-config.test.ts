import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { BackupBlob, BackupStore } from "./backup.ts";
import {
  type BackupRun,
  BackupConfigError,
  decryptBackupToken,
  describeBackupError,
  describeBucketGrant,
  encryptBackupToken,
  parseBackupConfigInput,
  resolveBackupConfig,
  type StoredBackupConfig,
  summarizeBackupStatus,
  testBackupTarget,
} from "./backup-config.ts";
import {
  createGcsBackupStore,
  createLocalBackupStore,
} from "./backup-stores.ts";
import { type GcsClient, GcsRequestError } from "./services/storage/gcs.ts";

const env = { BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-1234" };

function stored(
  overrides: Partial<StoredBackupConfig> = {},
): StoredBackupConfig {
  return {
    blobTokenEncrypted: null,
    destination: "none",
    enabled: true,
    gcsBucket: null,
    gcsPrefix: "",
    keepDays: 30,
    updatedAt: 0,
    updatedBy: null,
    ...overrides,
  };
}

test("the form in Settings is read, and mistakes are named", () => {
  assert.deepEqual(
    parseBackupConfigInput({
      destination: {
        bucket: " gs://my-backups/ ",
        kind: "gcs",
        prefix: "/a/b/",
      },
      enabled: true,
      keepDays: "45",
    }),
    {
      destination: { bucket: "my-backups", kind: "gcs", prefix: "a/b/" },
      enabled: true,
      keepDays: 45,
    },
  );
  assert.deepEqual(
    parseBackupConfigInput({
      destination: { kind: "blob", token: "" },
      enabled: false,
      keepDays: 30,
    }),
    {
      destination: { kind: "blob", token: null },
      enabled: false,
      keepDays: 30,
    },
  );

  for (const body of [
    { destination: { bucket: "Not A Bucket", kind: "gcs" }, keepDays: 30 },
    {
      destination: { bucket: "ok-bucket", kind: "gcs", prefix: "../x" },
      keepDays: 30,
    },
    { destination: { kind: "blob", token: "secret" }, keepDays: 30 },
    { destination: { kind: "gcs", bucket: "ok-bucket" }, keepDays: 0 },
    { destination: { kind: "s3" }, keepDays: 30 },
    null,
  ]) {
    assert.throws(() => parseBackupConfigInput(body), BackupConfigError);
  }
});

test("the environment wins over what was saved, and locks it", () => {
  const saved = stored({
    destination: "gcs",
    gcsBucket: "saved",
    keepDays: 10,
  });

  assert.deepEqual(resolveBackupConfig(saved, env), {
    enabled: true,
    keepDays: 10,
    locked: { destination: false, keepDays: false },
    target: { bucket: "saved", kind: "gcs", prefix: "" },
    tokenUnreadable: false,
  });

  assert.deepEqual(
    resolveBackupConfig(stored({ ...saved, enabled: false }), {
      ...env,
      BACKUP_GCS_BUCKET: "from-env",
      BACKUP_KEEP_DAYS: "60",
    }),
    {
      enabled: true,
      keepDays: 60,
      locked: { destination: true, keepDays: true },
      target: { bucket: "from-env", kind: "gcs", prefix: "" },
      tokenUnreadable: false,
    },
  );

  assert.deepEqual(resolveBackupConfig(null, env).target, null);
  assert.equal(resolveBackupConfig(null, env).keepDays, 30);
});

test("a saved Blob token is kept encrypted, and a changed secret is noticed", () => {
  const encrypted = encryptBackupToken("vercel_blob_rw_Store1_secret", env);

  assert.doesNotMatch(encrypted, /secret/);
  assert.equal(
    decryptBackupToken(encrypted, env),
    "vercel_blob_rw_Store1_secret",
  );

  assert.deepEqual(
    resolveBackupConfig(
      stored({ blobTokenEncrypted: encrypted, destination: "blob" }),
      env,
    ).target,
    { kind: "blob", token: "vercel_blob_rw_Store1_secret" },
  );

  const otherSecret = resolveBackupConfig(
    stored({ blobTokenEncrypted: encrypted, destination: "blob" }),
    { BETTER_AUTH_SECRET: "a-different-secret-that-is-long-enough" },
  );

  assert.equal(otherSecret.target, null);
  assert.equal(otherSecret.tokenUnreadable, true);
  assert.equal(summarizeBackupStatus(otherSecret, []).state, "failing");
});

function run(overrides: Partial<BackupRun>): BackupRun {
  return {
    destination: "gs://b/",
    error: null,
    finishedAt: 1_000,
    id: "r",
    startedAt: 1_000,
    status: "succeeded",
    summary: null,
    trigger: "schedule",
    ...overrides,
  };
}

test("the setup status says whether backups are set up and working", () => {
  const configured = resolveBackupConfig(
    stored({ destination: "gcs", gcsBucket: "b" }),
    env,
  );
  const day = 24 * 60 * 60;

  assert.equal(
    summarizeBackupStatus(resolveBackupConfig(null, env), []).state,
    "not_configured",
  );
  assert.equal(
    summarizeBackupStatus({ ...configured, enabled: false }, []).state,
    "not_configured",
  );
  assert.equal(summarizeBackupStatus(configured, []).state, "done");
  assert.equal(
    summarizeBackupStatus(
      configured,
      [run({ startedAt: 10 * day })],
      10 * day + 60,
    ).state,
    "done",
  );
  assert.deepEqual(
    summarizeBackupStatus(
      configured,
      [
        run({
          error: "Google Cloud Storage refused access (403).",
          status: "failed",
        }),
      ],
      1_000,
    ),
    { message: "Google Cloud Storage refused access (403).", state: "failing" },
  );
  assert.equal(
    summarizeBackupStatus(configured, [run({ startedAt: 0 })], 3 * day).state,
    "failing",
  );
  // A run still going does not hide the one before it.
  assert.equal(
    summarizeBackupStatus(
      configured,
      [run({ status: "running" }), run({ status: "partial" })],
      1_000,
    ).state,
    "failing",
  );
});

test("failures are described without bodies or secrets", () => {
  assert.match(
    describeBackupError(new GcsRequestError("upload", 403)),
    /roles\/storage\.objectAdmin/,
  );
  assert.match(
    describeBackupError(new GcsRequestError("list", 404)),
    /no such bucket/,
  );
  assert.equal(
    describeBackupError(new Error("password=hunter2")),
    "The backup failed.",
  );
  assert.equal(
    describeBackupError(new TypeError("fetch failed: secret")),
    "The backup failed (TypeError).",
  );
  assert.match(
    describeBucketGrant("my-backups", "app@project.iam.gserviceaccount.com"),
    /gcloud storage buckets add-iam-policy-binding gs:\/\/my-backups --member=serviceAccount:app@project\.iam\.gserviceaccount\.com --role=roles\/storage\.objectAdmin/,
  );
});

/** A store kept in memory, optionally failing one kind of call. */
function memoryStore(fail?: { method: keyof BackupStore; error: Error }) {
  const objects = new Map<string, string>();
  const guard = (method: keyof BackupStore) => {
    if (fail?.method === method) {
      throw fail.error;
    }
  };
  const store: BackupStore = {
    async delete(pathnames) {
      guard("delete");
      pathnames.forEach((pathname) => objects.delete(pathname));
    },
    async get(pathname) {
      guard("get");
      const value = objects.get(pathname);

      return value === undefined
        ? null
        : { contentType: "text/plain", stream: new Blob([value]).stream() };
    },
    async list({ prefix = "" }) {
      guard("list");
      const blobs: BackupBlob[] = [...objects.keys()]
        .filter((pathname) => pathname.startsWith(prefix))
        .map((pathname) => ({ pathname, size: 1, uploadedAt: new Date() }));

      return { blobs, hasMore: false };
    },
    async put(pathname, body) {
      guard("put");
      objects.set(pathname, String(body));
    },
  };

  return { objects, store };
}

test("testing a destination writes, lists, reads and deletes a file", async () => {
  const { objects, store } = memoryStore();

  assert.deepEqual(
    await testBackupTarget(
      { bucket: "b", kind: "gcs", prefix: "" },
      { createTarget: () => store, env },
    ),
    { ok: true },
  );
  assert.equal(objects.size, 0, "the test file is cleaned up");
});

test("a destination the app may not write to says which role to grant", async () => {
  const { store } = memoryStore({
    error: new GcsRequestError("upload", 403),
    method: "put",
  });
  const result = await testBackupTarget(
    { bucket: "my-backups", kind: "gcs", prefix: "" },
    {
      createTarget: () => store,
      env,
      serviceAccountEmail: async () => "app@project.iam.gserviceaccount.com",
    },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.step, "write");
  assert.match(result.message, /403/);
  assert.match(
    result.hint ?? "",
    /roles\/storage\.objectAdmin on gs:\/\/my-backups to app@project/,
  );

  const listing = memoryStore({
    error: new GcsRequestError("list", 403),
    method: "list",
  });
  const listed = await testBackupTarget(
    { bucket: "my-backups", kind: "gcs", prefix: "" },
    {
      createTarget: () => listing.store,
      env,
      serviceAccountEmail: async () => null,
    },
  );

  assert.ok(!listed.ok);
  assert.equal(listed.step, "list");

  // The app's own bucket is turned away before anything is written.
  const own = await testBackupTarget(
    { bucket: "docs", kind: "gcs", prefix: "" },
    { createTarget: () => store, env: { ...env, GCS_BUCKET: "docs" } },
  );

  assert.ok(!own.ok);
  assert.match(own.message, /own files/);
});

test("a destination the app may write to but not read from fails at the read step", async () => {
  const { store } = memoryStore({
    error: new GcsRequestError("download", 403),
    method: "get",
  });
  const result = await testBackupTarget(
    { bucket: "my-backups", kind: "gcs", prefix: "" },
    { createTarget: () => store, env, serviceAccountEmail: async () => null },
  );

  assert.ok(!result.ok);
  assert.equal(result.step, "read");
  assert.match(result.message, /403/);
});

test("a destination whose files cannot be deleted fails at the delete step", async () => {
  const { store } = memoryStore({
    error: new GcsRequestError("delete", 403),
    method: "delete",
  });
  const result = await testBackupTarget(
    { bucket: "my-backups", kind: "gcs", prefix: "" },
    { createTarget: () => store, env, serviceAccountEmail: async () => null },
  );

  assert.ok(!result.ok);
  assert.equal(result.step, "delete");
});

test("a destination that reads back something else fails at the read step", async () => {
  const { store } = memoryStore();
  const wrongBytes: BackupStore = {
    ...store,
    get: async () => ({
      contentType: "text/plain",
      stream: new Blob(["something else"]).stream(),
    }),
  };
  const result = await testBackupTarget(
    { bucket: "my-backups", kind: "gcs", prefix: "" },
    {
      createTarget: () => wrongBytes,
      env,
      serviceAccountEmail: async () => null,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.step, "read");
  assert.match(result.message, /did not read back/);
});

test("a bucket store keeps everything under its folder", async () => {
  const names = new Map<string, { body: string; contentType: string }>();
  const client: GcsClient = {
    bucket: "b",
    async deleteObject(name) {
      return names.delete(name) ? "deleted" : "not-found";
    },
    async download(name) {
      const found = names.get(name);

      return found
        ? new Response(found.body, {
            headers: { "content-type": found.contentType },
          })
        : null;
    },
    async getMetadata() {
      return null;
    },
    async list({ prefix = "" }) {
      return {
        items: [...names.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name, size: 1, updated: new Date(0) })),
      };
    },
    async upload(name, body, { contentType }) {
      names.set(name, { body: String(body), contentType });
      return "stored";
    },
    async uploadStream(name, body, { contentType }) {
      const chunks: Buffer[] = [];

      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }

      names.set(name, { body: Buffer.concat(chunks).toString(), contentType });
    },
  };
  const store = createGcsBackupStore({ client, prefix: "backups/" });

  await store.put("manifest.json", "{}", { contentType: "application/json" });
  await store.put("files/a.pdf", new Blob(["pdf"]).stream(), {
    contentType: "application/pdf",
  });

  assert.deepEqual([...names.keys()].sort(), [
    "backups/files/a.pdf",
    "backups/manifest.json",
  ]);

  const page = await store.list({ prefix: "files/" });

  assert.deepEqual(
    page.blobs.map((blob) => blob.pathname),
    ["files/a.pdf"],
  );

  const found = await store.get("files/a.pdf");

  assert.equal(found?.contentType, "application/pdf");
  assert.equal(await new Response(found?.stream).text(), "pdf");
  assert.equal(await store.get("missing"), null);

  await store.delete(["files/a.pdf"]);
  assert.equal(names.has("backups/files/a.pdf"), false);
});

test("the local store lists its files without their metadata", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "signudoc-backup-local-"));

  try {
    const store = createLocalBackupStore({ STORAGE_LOCAL_DIR: rootDir });

    await store.put("users/u1/a.pdf", Buffer.from("pdf"), {
      contentType: "application/pdf",
    });
    await writeFile(path.join(rootDir, "users", "u1", "left.tmp"), "x");

    const page = await store.list({});

    assert.deepEqual(
      page.blobs.map((blob) => blob.pathname),
      ["users/u1/a.pdf"],
    );

    const found = await store.get("users/u1/a.pdf");

    assert.equal(found?.contentType, "application/pdf");
    assert.equal(await new Response(found?.stream).text(), "pdf");
    assert.equal(await store.get("users/u1/missing.pdf"), null);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test("an invalid backup folder in the environment is a configuration problem, not a crash", () => {
  const broken = {
    ...env,
    BACKUP_GCS_BUCKET: "from-env",
    BACKUP_GCS_PREFIX: "a//b",
  };
  const config = resolveBackupConfig(
    stored({ destination: "gcs", gcsBucket: "saved" }),
    broken,
  );

  assert.equal(config.target, null);
  assert.match(config.problem ?? "", /BACKUP_GCS_PREFIX/);

  const status = summarizeBackupStatus(config, []);

  assert.equal(status.state, "failing");
  assert.match(status.message, /BACKUP_GCS_PREFIX/);
});

test("a dotted bucket name can be longer than 63 characters", () => {
  const part = "a".repeat(50);
  const long = `${part}.${part}`;

  assert.equal(long.length, 101);
  assert.equal(
    (
      parseBackupConfigInput({
        destination: { bucket: long, kind: "gcs" },
        keepDays: 30,
      }).destination as { bucket: string }
    ).bucket,
    long,
  );

  // A part over 63 characters, or an undotted name over 63, is refused.
  for (const bucket of [`${"a".repeat(64)}.${part}`, "a".repeat(64)]) {
    assert.throws(
      () =>
        parseBackupConfigInput({
          destination: { bucket, kind: "gcs" },
          keepDays: 30,
        }),
      BackupConfigError,
    );
  }
});
