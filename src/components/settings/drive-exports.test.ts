import assert from "node:assert/strict";
import test from "node:test";

import { exportsView, readExports } from "./drive-exports.ts";

test("a failed reply is not an empty list", () => {
  assert.equal(readExports(null), null);
  assert.equal(readExports({}), null);
  assert.equal(readExports({ error: "boom" } as { exports?: string[] }), null);
});

test("a list reply is read as it is, empty or not", () => {
  assert.deepEqual(readExports({ exports: [] }), []);
  assert.deepEqual(readExports({ exports: ["a"] }), ["a"]);
});

test("a failed first load is shown as failed, not as loading forever", () => {
  assert.equal(exportsView(null, false), "loading");
  assert.equal(exportsView(null, true), "failed");
  assert.equal(exportsView([], false), "empty");
  assert.equal(exportsView(["a"], false), "list");
  // A failed refresh keeps the list it had.
  assert.equal(exportsView(["a"], true), "list");
  assert.equal(exportsView([], true), "empty");
});
