import assert from "node:assert/strict";
import { test } from "node:test";

import { isWorkspaceSettingKey, resolveWorkspaceSetting } from "./settings.ts";

test("the environment wins over what is stored, and says so", () => {
  assert.deepEqual(
    resolveWorkspaceSetting(
      "workspace.provider",
      { "workspace.provider": "google" },
      { WORKSPACE_PROVIDER: "other" },
    ),
    { source: "env", value: "other" },
  );
  assert.deepEqual(
    resolveWorkspaceSetting(
      "workspace.provider",
      { "workspace.provider": " google " },
      {},
    ),
    { source: "settings", value: "google" },
  );
  assert.deepEqual(resolveWorkspaceSetting("workspace.provider", null, {}), {
    source: "none",
    value: null,
  });
  // An empty variable is not set.
  assert.deepEqual(
    resolveWorkspaceSetting(
      "workspace.provider",
      { "workspace.provider": "google" },
      { WORKSPACE_PROVIDER: "" },
    ),
    { source: "settings", value: "google" },
  );
});

test("only known keys are settings", () => {
  assert.equal(isWorkspaceSettingKey("workspace.provider"), true);
  assert.equal(isWorkspaceSettingKey("toString"), false);
  assert.equal(isWorkspaceSettingKey("google.serviceAccountKey"), false);
});
