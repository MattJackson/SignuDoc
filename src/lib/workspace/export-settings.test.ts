import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkspaceFilesUpdate,
  WorkspaceFilesSettingsError,
} from "./export-settings.ts";
import { DEFAULT_EXPORT_FOLDER_PATTERN } from "./exports.ts";

// What an administrator's change to the files settings saves: values are
// checked, a setting the environment fixes is left alone, and the default
// layout is not stored.

const normalize = (value: string) =>
  /^[A-Za-z0-9_-]{10,}$/.test(value.trim()) ? value.trim() : null;

test("a change is checked and turned into settings", () => {
  assert.deepEqual(
    buildWorkspaceFilesUpdate(
      {
        destination: "0AAbCdEfGhIjKUk9PVA",
        driveLabelFields: { f1: "title", f2: "" },
        driveLabelId: "labels/abc123",
        folderPattern: DEFAULT_EXPORT_FOLDER_PATTERN,
        pickerApiKey: "AIzaSyA-1234567890abcdefgh",
        pickerAppId: "123456789012",
      },
      normalize,
      {},
      {},
    ),
    {
      "files.exportDestination": "0AAbCdEfGhIjKUk9PVA",
      "files.exportFolderPattern": null,
      "google.driveLabelFields": JSON.stringify({ f1: "title" }),
      "google.driveLabelId": "abc123",
      "google.pickerApiKey": "AIzaSyA-1234567890abcdefgh",
      "google.pickerAppId": "123456789012",
    },
  );
});

test("an empty destination turns copies off; clearing the label clears its fields", () => {
  assert.deepEqual(
    buildWorkspaceFilesUpdate(
      { destination: "", driveLabelFields: { f1: "title" }, driveLabelId: "" },
      normalize,
      {},
      {},
    ),
    {
      "files.exportDestination": null,
      "google.driveLabelFields": null,
      "google.driveLabelId": null,
    },
  );
});

test("a setting fixed by the environment is not changed", () => {
  assert.deepEqual(
    buildWorkspaceFilesUpdate(
      { destination: "0AOtherDrive123", folderPattern: "{yyyy}/{title}" },
      normalize,
      {},
      { WORKSPACE_EXPORT_DESTINATION: "0AEnvDrive12345" },
    ),
    { "files.exportFolderPattern": "{yyyy}/{title}" },
  );
});

test("values that cannot be right are reported by field", () => {
  assert.throws(
    () =>
      buildWorkspaceFilesUpdate(
        {
          destination: "not a drive!",
          driveLabelFields: { f1: "nope" },
          driveLabelId: "x",
          folderPattern: "{yyyy}/",
          pickerApiKey: "short",
          pickerAppId: "abc",
        },
        normalize,
        {},
        {},
      ),
    (error) =>
      error instanceof WorkspaceFilesSettingsError &&
      Object.keys(error.fieldErrors).sort().join() ===
        "destination,driveLabelFields,folderPattern,pickerApiKey,pickerAppId",
  );
});

test("before files are set up, only a plain id is taken as the destination", () => {
  assert.deepEqual(
    buildWorkspaceFilesUpdate({ destination: " 0AAbCdEf " }, null, {}, {}),
    { "files.exportDestination": "0AAbCdEf" },
  );
  assert.throws(
    () =>
      buildWorkspaceFilesUpdate(
        { destination: "https://drive.google.com/drive/folders/0AAbCdEf" },
        null,
        {},
        {},
      ),
    WorkspaceFilesSettingsError,
  );
});
