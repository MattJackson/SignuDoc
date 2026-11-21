import assert from "node:assert/strict";
import { test } from "node:test";

import * as catalog from "./integrations-catalog.ts";

// The "N of M are connected" sentence on the Integrations page counts only
// the cards shown.

test("only the integrations in the groups shown are counted", () => {
  const { countConnected, INTEGRATIONS } = catalog as unknown as {
    countConnected: (
      states: Record<string, { status: string }>,
      groups: readonly string[],
    ) => { connected: number; total: number };
    INTEGRATIONS: readonly { id: string }[];
  };
  const states: Record<string, { status: string }> = {};

  for (const integration of INTEGRATIONS) {
    states[integration.id] = { status: "not_set_up" };
  }

  states.storage = { status: "connected" };
  states.email = { status: "connected" };

  assert.deepEqual(countConnected(states, ["Email and messaging"]), {
    connected: 1,
    total: 2,
  });
  assert.deepEqual(
    countConnected(states, [
      "Email and messaging",
      "Google Workspace",
      "Storage",
    ]),
    { connected: 2, total: INTEGRATIONS.length },
  );
});
