import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkspaceSettingsInput,
  WorkspaceSettingsInputError,
} from "./admin-view.ts";

// What the workspace settings page may save: values are checked and
// normalized, empty clears, and a value the environment fixes is left out.

function fieldErrorsOf(input: unknown, env = {}) {
  try {
    parseWorkspaceSettingsInput(input, env);
  } catch (error) {
    assert.ok(error instanceof WorkspaceSettingsInputError);

    return error.fieldErrors;
  }

  return null;
}

test("good values are normalized, and empty ones clear the setting", () => {
  assert.deepEqual(
    parseWorkspaceSettingsInput(
      {
        settings: {
          "directory.adminGroup": " Admins@Example.com ",
          "directory.enabled": "on",
          "google.adminSubject": "Boss@Example.com",
          "google.customerId": "C01ab2cd3",
          "workspace.provider": "Google",
        },
      },
      {},
    ),
    {
      "directory.adminGroup": "admins@example.com",
      "directory.enabled": "on",
      "google.adminSubject": "boss@example.com",
      "google.customerId": "C01ab2cd3",
      "workspace.provider": "google",
    },
  );
  assert.deepEqual(
    parseWorkspaceSettingsInput(
      { settings: { "directory.adminGroup": "", "workspace.provider": null } },
      {},
    ),
    { "directory.adminGroup": null, "workspace.provider": null },
  );
});

test("bad values are reported per field", () => {
  assert.deepEqual(
    Object.keys(
      fieldErrorsOf({
        settings: {
          "directory.adminGroup": "admins",
          "directory.enabled": "yes",
          "google.adminSubject": "not an address",
          "google.customerId": "C01-ab",
          "workspace.provider": "lotus-notes",
        },
      }) ?? {},
    ).sort(),
    [
      "directory.adminGroup",
      "directory.enabled",
      "google.adminSubject",
      "google.customerId",
      "workspace.provider",
    ],
  );
});

test("unknown keys are refused, and what the environment sets is left alone", () => {
  assert.throws(
    () =>
      parseWorkspaceSettingsInput(
        { settings: { "google.serviceAccountKey": "{}" } },
        {},
      ),
    /Unknown setting/,
  );
  assert.throws(() => parseWorkspaceSettingsInput(null, {}), /Nothing to save/);
  assert.deepEqual(
    parseWorkspaceSettingsInput(
      {
        settings: {
          "directory.adminGroup": "admins",
          "directory.enabled": "on",
        },
      },
      { WORKSPACE_ADMIN_GROUP: "it@example.com" },
    ),
    { "directory.enabled": "on" },
  );
});

test("the add-on's values from Google are checked", () => {
  assert.deepEqual(
    parseWorkspaceSettingsInput(
      {
        settings: {
          "google.addonClientId": "117000000000000000001",
          "google.addonServiceAccount":
            "Service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
        },
      },
      {},
    ),
    {
      "google.addonClientId": "117000000000000000001",
      "google.addonServiceAccount":
        "service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    },
  );
  assert.deepEqual(
    Object.keys(
      fieldErrorsOf({
        settings: {
          "google.addonClientId": "has spaces",
          "google.addonServiceAccount": "someone@gmail.com",
        },
      }) ?? {},
    ).sort(),
    ["google.addonClientId", "google.addonServiceAccount"],
  );
});
