import assert from "node:assert/strict";
import { test } from "node:test";

import { safeReturnPath } from "./return-path.ts";

// The path a visitor is sent back to after signing in.

test("a repeated query key, which arrives as a list, falls back", () => {
  assert.equal(
    safeReturnPath(["/a", "/b"] as unknown as string, "/dashboard"),
    "/dashboard",
  );
});

test("a path on this site is kept and anything else falls back", () => {
  assert.equal(safeReturnPath("/envelopes", "/dashboard"), "/envelopes");
  assert.equal(safeReturnPath("//evil.example", "/dashboard"), "/dashboard");
  assert.equal(safeReturnPath(undefined, "/dashboard"), "/dashboard");
});
