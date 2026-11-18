import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  createAppFilesStore,
  createBackupTargetStore,
  createLocalBackupStore,
} from "./backup-stores.ts";
import { createLocalStorageService } from "./services/storage/local.ts";

let previousKey: string | undefined;

before(() => {
  previousKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
});

after(() => {
  if (previousKey === undefined) {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  } else {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = previousKey;
  }
});

test("a malformed service account key does not stop a backup that never uses it", () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "{bad";

  assert.ok(createBackupTargetStore({ kind: "blob", token: "t" }));
  assert.ok(createAppFilesStore({ env: { STORAGE_DRIVER: "local" } }));
});

test("an empty STORAGE_LOCAL_DIR is read the same way by the storage and by the backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "signudoc-local-dir-"));
  const previousDirectory = process.cwd();

  // Both fall back to .data/storage under the working directory.
  process.chdir(directory);

  try {
    const env = { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "" };

    await createLocalStorageService({ env }).putObject({
      body: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      key: "a/b.txt",
    });

    const listed = await createLocalBackupStore(env).list({});

    assert.deepEqual(
      listed.blobs.map((blob) => blob.pathname),
      ["a/b.txt"],
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(directory, { force: true, recursive: true });
  }
});
