import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isBackupStoreTheAppStore,
  parseKeepDays,
  readBackupSettings,
  readBackupTargetFromEnv,
} from "./backup.ts";

test("backups are off until a backup target is set", () => {
  assert.equal(readBackupSettings({}), null);
  assert.deepEqual(
    readBackupSettings({ BACKUP_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_B_x" }),
    { keepDays: 30, target: { kind: "blob", token: "vercel_blob_rw_B_x" } },
  );

  for (const [value, expected] of [
    ["7", 7],
    ["0", 30],
    ["many", 30],
    ["99999", 30],
  ] as const) {
    assert.equal(
      readBackupSettings({
        BACKUP_BLOB_READ_WRITE_TOKEN: "t",
        BACKUP_KEEP_DAYS: value,
      })?.keepDays,
      expected,
    );
  }
});

test("a Cloud Storage bucket can be the backup target, and wins over Blob", () => {
  assert.deepEqual(
    readBackupSettings({
      BACKUP_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_B_x",
      BACKUP_GCS_BUCKET: "gs://signudoc-backups/",
      BACKUP_GCS_PREFIX: "/acme/",
      BACKUP_KEEP_DAYS: "90",
    }),
    {
      keepDays: 90,
      target: { bucket: "signudoc-backups", kind: "gcs", prefix: "acme/" },
    },
  );
  assert.deepEqual(readBackupSettings({ BACKUP_GCS_BUCKET: "b" })?.target, {
    bucket: "b",
    kind: "gcs",
    prefix: "",
  });
});

test("keep-days must be a whole number of days in range", () => {
  assert.equal(parseKeepDays("30"), 30);
  assert.equal(parseKeepDays(365), 365);
  assert.equal(parseKeepDays(" 7 "), 7);
  assert.equal(parseKeepDays("7.5"), null);
  assert.equal(parseKeepDays(0), null);
  assert.equal(parseKeepDays(3651), null);
  assert.equal(parseKeepDays(null), null);
});

test("a backup token for the app's own store is caught", () => {
  const settings = {
    target: { kind: "blob", token: "vercel_blob_rw_AbC123_secret" } as const,
  };

  assert.equal(
    isBackupStoreTheAppStore(settings, {
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc123_other",
    }),
    true,
  );
  assert.equal(
    isBackupStoreTheAppStore(settings, { BLOB_STORE_ID: "store_AbC123" }),
    true,
  );
  assert.equal(
    isBackupStoreTheAppStore(settings, {
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_Other9_x",
    }),
    false,
  );
});

test("the app's own bucket is refused as the backup bucket", () => {
  const settings = {
    target: { bucket: "Docs", kind: "gcs", prefix: "backup/" } as const,
  };

  assert.equal(
    isBackupStoreTheAppStore(settings, {
      GCS_BUCKET: "docs",
      GCS_PREFIX: "files",
    }),
    true,
  );
  assert.equal(
    isBackupStoreTheAppStore(settings, { GCS_BUCKET: "other" }),
    false,
  );
  assert.equal(isBackupStoreTheAppStore(settings, {}), false);
});

test("a folder in the environment that cannot be one is reported by name", () => {
  for (const prefix of ["a//b", "../x"]) {
    assert.throws(
      () =>
        readBackupTargetFromEnv({
          BACKUP_GCS_BUCKET: "b",
          BACKUP_GCS_PREFIX: prefix,
        }),
      /BACKUP_GCS_PREFIX/,
    );
  }
});
