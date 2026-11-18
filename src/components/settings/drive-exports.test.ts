import assert from "node:assert/strict";
import test from "node:test";

import { readExports } from "./drive-exports.ts";

test("a failed reply is not an empty list", () => {
  assert.equal(readExports(null), null);
  assert.equal(readExports({}), null);
  assert.equal(readExports({ error: "boom" } as { exports?: string[] }), null);
});

test("a list reply is read as it is, empty or not", () => {
  assert.deepEqual(readExports({ exports: [] }), []);
  assert.deepEqual(readExports({ exports: ["a"] }), ["a"]);
});
