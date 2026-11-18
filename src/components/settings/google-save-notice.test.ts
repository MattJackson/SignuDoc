import assert from "node:assert/strict";
import test from "node:test";

import { saveFailureMessage } from "./google-save-notice.ts";

test("a failure with no field errors shows the real error", () => {
  assert.equal(
    saveFailureMessage({}, "Server unavailable."),
    "Server unavailable.",
  );
});

test("a failure with field errors points at the fields", () => {
  assert.equal(
    saveFailureMessage({ adminGroup: "Not a group." }, "Nope."),
    "Check the highlighted fields.",
  );
});
