import assert from "node:assert/strict";
import test from "node:test";

import { preferenceCheckboxLabel } from "./preference-label.ts";

const row = { kind: "envelope_completed", label: "Envelope completed" };

test("the checkbox is named by the row's visible label, never its id", () => {
  for (const scope of ["own", "team"] as const) {
    const name = preferenceCheckboxLabel(row, scope);

    assert.ok(name.startsWith("Envelope completed, "), name);
    assert.ok(!name.includes("envelope_completed"), name);
  }

  assert.equal(
    preferenceCheckboxLabel(row, "own"),
    "Envelope completed, for my envelopes",
  );
  assert.equal(
    preferenceCheckboxLabel(row, "team"),
    "Envelope completed, for my teams' envelopes",
  );
});
