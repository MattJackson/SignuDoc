import assert from "node:assert/strict";
import test from "node:test";

import { preferenceCheckboxLabel } from "./preference-label.ts";

test("the checkbox is named by the visible label, then the scope", () => {
  assert.equal(
    preferenceCheckboxLabel("Envelope completed", "own"),
    "Envelope completed, for my envelopes",
  );
  assert.equal(
    preferenceCheckboxLabel("Envelope completed", "team"),
    "Envelope completed, for my teams' envelopes",
  );
});
