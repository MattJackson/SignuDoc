import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDisposableDatabase } from "../../e2e/support/database.ts";

// The end-to-end setup drops every table of the database it is pointed at,
// so it first checks that the database is one meant for tests.

test("a database with e2e in its own name may be wiped", () => {
  assert.doesNotThrow(() =>
    assertDisposableDatabase("sqlite:/tmp/x/signudoc_e2e.db"),
  );
  assert.doesNotThrow(() =>
    assertDisposableDatabase("postgres://u:p@h/signudoc_e2e"),
  );
});

test("a database is refused when only a folder on its path says e2e", () => {
  assert.throws(
    () => assertDisposableDatabase("sqlite:/srv/e2e-host/signudoc.db"),
    /Refusing to wipe/,
  );
  assert.throws(
    () => assertDisposableDatabase("sqlite:/tmp/signudoc-e2e/prod.db"),
    /Refusing to wipe/,
  );
  assert.throws(
    () => assertDisposableDatabase("postgres://u:p@h/signudoc"),
    /Refusing to wipe/,
  );
});
