import assert from "node:assert/strict";
import test from "node:test";

import {
  draftFromRule,
  EMPTY_RULE,
  ruleBody,
} from "./notification-rule-draft.ts";

const rule = {
  destination: "C123",
  destinationName: "#sales",
  events: ["envelope_completed" as const],
  id: "rule-1",
  teamId: null,
};

test("editing a paused rule and saving keeps it paused", () => {
  const body = ruleBody(draftFromRule({ ...rule, enabled: false }));

  assert.equal((body as { enabled?: boolean }).enabled, false);
});

test("editing an active rule keeps it active, and a new rule starts active", () => {
  const body = ruleBody(draftFromRule({ ...rule, enabled: true }));

  assert.equal((body as { enabled?: boolean }).enabled, true);
  assert.equal((ruleBody(EMPTY_RULE) as { enabled?: boolean }).enabled, true);
});
