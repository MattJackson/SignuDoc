import assert from "node:assert/strict";
import { test } from "node:test";

import {
  matchNotificationTargets,
  ruleMatches,
  type NotificationRuleRecord,
  type TargetInput,
} from "./targets.ts";

// Who an event goes to: rules, the sender's defaults, teammates who opted
// in, administrators for the install's own events, and the line that keeps
// a team's channel to that team's envelopes.

const slack = { configured: true, directMessages: true, id: "slack" };

function rule(
  overrides: Partial<NotificationRuleRecord>,
): NotificationRuleRecord {
  return {
    channel: "slack",
    destination: "C0ALL",
    enabled: true,
    events: ["envelope_completed"],
    id: "rule-all",
    teamId: null,
    ...overrides,
  };
}

function input(overrides: Partial<TargetInput> = {}): TargetInput {
  return {
    adminIds: [],
    channels: [slack],
    envelope: { isDraft: false, ownerId: "owner", ownerTeamIds: ["sales"] },
    kind: "envelope_completed",
    preferences: [],
    rules: [],
    teammateIds: ["teammate"],
    ...overrides,
  };
}

function describe(targets: ReturnType<typeof matchNotificationTargets>) {
  return targets
    .map((target) => `${target.targetKind}:${target.target}`)
    .sort();
}

test("the sender gets the events that are on by default, and no one else does", () => {
  assert.deepEqual(describe(matchNotificationTargets(input())), ["user:owner"]);
  assert.deepEqual(
    describe(matchNotificationTargets(input({ kind: "envelope_viewed" }))),
    [],
  );
});

test("the sender can turn an event off, or one on", () => {
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          preferences: [
            {
              channel: "slack",
              enabled: false,
              event: "envelope_completed",
              scope: "own",
              userId: "owner",
            },
          ],
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          kind: "envelope_viewed",
          preferences: [
            {
              channel: "slack",
              enabled: true,
              event: "envelope_viewed",
              scope: "own",
              userId: "owner",
            },
          ],
        }),
      ),
    ),
    ["user:owner"],
  );
});

test("a teammate only hears about a teammate's envelope after opting in", () => {
  const optedIn = input({
    preferences: [
      {
        channel: "slack",
        enabled: true,
        event: "envelope_completed",
        scope: "team",
        userId: "teammate",
      },
    ],
  });

  assert.deepEqual(describe(matchNotificationTargets(optedIn)), [
    "user:owner",
    "user:teammate",
  ]);

  // A choice for their own envelopes says nothing about their teammates'.
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          preferences: [
            {
              channel: "slack",
              enabled: true,
              event: "envelope_completed",
              scope: "own",
              userId: "teammate",
            },
          ],
        }),
      ),
    ),
    ["user:owner"],
  );

  // A draft is the sender's alone.
  assert.deepEqual(
    describe(
      matchNotificationTargets({
        ...optedIn,
        envelope: { isDraft: true, ownerId: "owner", ownerTeamIds: ["sales"] },
      }),
    ),
    ["user:owner"],
  );
});

test("a rule for every envelope posts the events it names", () => {
  assert.deepEqual(
    describe(matchNotificationTargets(input({ rules: [rule({})] }))),
    ["channel:C0ALL", "user:owner"],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({ kind: "envelope_signed", rules: [rule({})] }),
      ),
    ),
    ["user:owner"],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(input({ rules: [rule({ enabled: false })] })),
    ),
    ["user:owner"],
  );
});

test("a team's rule only takes envelopes sent by that team's members", () => {
  const salesRule = rule({
    destination: "C0SALES",
    id: "rule-sales",
    teamId: "sales",
  });
  const legalRule = rule({
    destination: "C0LEGAL",
    id: "rule-legal",
    teamId: "legal",
  });
  const targets = matchNotificationTargets(
    input({ rules: [salesRule, legalRule] }),
  );

  assert.deepEqual(describe(targets), ["channel:C0SALES", "user:owner"]);
  assert.equal(
    targets.find((target) => target.targetKind === "channel")?.ruleId,
    "rule-sales",
  );

  // A sender on no team: no team's channel hears about it.
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          envelope: { isDraft: false, ownerId: "owner", ownerTeamIds: [] },
          rules: [salesRule],
        }),
      ),
    ),
    ["user:owner"],
  );
});

test("a team's rule never gets the install's own events", () => {
  const teamRule = rule({ events: ["backup_failed"], teamId: "sales" });
  const everyRule = rule({ events: ["backup_failed"], id: "rule-every" });
  const backup = input({
    adminIds: ["admin-1", "admin-2"],
    envelope: null,
    kind: "backup_failed",
    preferences: [
      {
        channel: "slack",
        enabled: false,
        event: "backup_failed",
        scope: "own",
        userId: "admin-2",
      },
    ],
    rules: [teamRule, everyRule],
    teammateIds: [],
  });

  assert.equal(ruleMatches(teamRule, backup), false);
  assert.deepEqual(describe(matchNotificationTargets(backup)), [
    "channel:C0ALL",
    "user:admin-1",
  ]);
});

test("nothing goes to a channel that is not set up, and no direct messages when they are off", () => {
  assert.deepEqual(
    matchNotificationTargets(
      input({
        channels: [{ configured: false, directMessages: false, id: "slack" }],
        rules: [rule({})],
      }),
    ),
    [],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          channels: [{ configured: true, directMessages: false, id: "slack" }],
          rules: [rule({})],
        }),
      ),
    ),
    ["channel:C0ALL"],
  );
});

test("two rules for the same channel make one delivery", () => {
  const targets = matchNotificationTargets(
    input({
      rules: [rule({}), rule({ id: "rule-sales", teamId: "sales" })],
    }),
  );

  assert.deepEqual(describe(targets), ["channel:C0ALL", "user:owner"]);
});
