import assert from "node:assert/strict";
import { test } from "node:test";

import { readAdminGroup } from "./google-admin-group.ts";

test("an administrator group in the environment that is not an address is reported by name", () => {
  const setting = readAdminGroup({ GOOGLE_ADMIN_GROUP: "Admins" });

  assert.equal(setting.group, null);
  assert.equal(setting.source, "env");
  assert.match(
    (setting as { problem?: string }).problem ?? "",
    /GOOGLE_ADMIN_GROUP/,
  );
});

test("a good administrator group has no problem", () => {
  const setting = readAdminGroup({ GOOGLE_ADMIN_GROUP: "Admins@Example.com" });

  assert.deepEqual(setting, { group: "admins@example.com", source: "env" });
  assert.deepEqual(readAdminGroup({}), { group: null, source: "none" });
});
