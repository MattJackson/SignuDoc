import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isDirectoryEnabled,
  normalizeGroupAddress,
  readAdminGroup,
} from "./directory-settings.ts";

test("the directory is off until it is turned on, and the environment wins", () => {
  assert.equal(isDirectoryEnabled(null, {}), false);
  assert.equal(isDirectoryEnabled({ "directory.enabled": "on" }, {}), true);
  assert.equal(
    isDirectoryEnabled(
      { "directory.enabled": "on" },
      { WORKSPACE_DIRECTORY: "off" },
    ),
    false,
  );
  assert.equal(isDirectoryEnabled(null, { WORKSPACE_DIRECTORY: "ON" }), true);
});

test("a group is named by its address", () => {
  assert.equal(
    normalizeGroupAddress(" Admins@Example.com "),
    "admins@example.com",
  );
  assert.equal(normalizeGroupAddress("admins"), null);
  assert.equal(normalizeGroupAddress("a b@example.com"), null);
});

test("the administrator group: the environment wins, and a bad one is reported by name", () => {
  assert.deepEqual(
    readAdminGroup(
      { "directory.adminGroup": "other@example.com" },
      { WORKSPACE_ADMIN_GROUP: "IT@example.com" },
    ),
    { group: "it@example.com", source: "env" },
  );
  assert.deepEqual(
    readAdminGroup({ "directory.adminGroup": "x@example.com" }, {}),
    { group: "x@example.com", source: "settings" },
  );
  assert.deepEqual(readAdminGroup(null, {}), { group: null, source: "none" });

  const bad = readAdminGroup(null, { WORKSPACE_ADMIN_GROUP: "Admins" });

  assert.equal(bad.group, null);
  assert.equal(bad.source, "env");
  assert.match(bad.problem ?? "", /WORKSPACE_ADMIN_GROUP/);
});
