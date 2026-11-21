import {
  NOTIFICATION_EVENTS,
  SELF_ACTION_KINDS,
  type NotificationEventKind,
} from "./events.ts";

// Who an event goes to, worked out from what is already known about it.
// No database and no chat tool here, so every case can be tested on its
// own (targets.test.ts); outbox.ts gathers the inputs.
//
// * A rule sends to its channel when it names the event and its chat tool
//   is set up. A rule for one team only takes envelopes sent by a member of
//   that team, and never the install's own events, so a team's channel
//   only ever hears about that team's envelopes.
// * The sender of an envelope gets a direct message for the events that
//   are on by default, unless they turned that event off.
// * A teammate (on a team with the sender) only gets one for an event they
//   turned on for their teams' envelopes. A draft is nobody's but the
//   sender's.
// * Every administrator gets the install's own events, unless they turned
//   them off.
// * Nobody hears about what they did themselves: a sender who signs their
//   own envelope gets no "you signed" message. A person is matched to the
//   event by email address. Channels still hear about it.

export type NotificationRuleRecord = {
  channel: string;
  destination: string;
  enabled: boolean;
  events: string[];
  id: string;
  teamId: string | null;
};

export type NotificationPreferenceRecord = {
  channel: string;
  enabled: boolean;
  event: string;
  scope: "own" | "team";
  userId: string;
};

export type ChannelAvailability = {
  configured: boolean;
  directMessages: boolean;
  id: string;
};

export type NotificationTarget = {
  channel: string;
  ruleId: string | null;
  target: string;
  targetKind: "channel" | "user";
};

export type TargetInput = {
  adminIds: string[];
  channels: ChannelAvailability[];
  /** Null for the install's own events. */
  envelope: {
    isDraft: boolean;
    ownerId: string;
    ownerTeamIds: string[];
  } | null;
  kind: NotificationEventKind;
  preferences: NotificationPreferenceRecord[];
  rules: NotificationRuleRecord[];
  /** People on a team with the sender, not the sender. */
  teammateIds: string[];
  /** Who did it (the event's actor and signer), lower-case email addresses. */
  actorEmails?: string[];
  /** The email address of each person who might get a direct message, by id. */
  userEmails?: Record<string, string>;
};

export function preferenceFor(
  preferences: NotificationPreferenceRecord[],
  userId: string,
  channel: string,
  event: string,
  scope: "own" | "team",
): boolean | null {
  const found = preferences.find(
    (preference) =>
      preference.userId === userId &&
      preference.channel === channel &&
      preference.event === event &&
      preference.scope === scope,
  );

  return found ? found.enabled : null;
}

export function ruleMatches(
  rule: NotificationRuleRecord,
  input: Pick<TargetInput, "envelope" | "kind">,
): boolean {
  const definition = NOTIFICATION_EVENTS[input.kind];

  if (!rule.enabled || !rule.events.includes(input.kind)) {
    return false;
  }

  if (input.envelope?.isDraft) {
    return false;
  }

  if (rule.teamId === null) {
    return true;
  }

  return (
    definition.audience === "envelope" &&
    input.envelope !== null &&
    input.envelope.ownerTeamIds.includes(rule.teamId)
  );
}

export function matchNotificationTargets(
  input: TargetInput,
): NotificationTarget[] {
  const definition = NOTIFICATION_EVENTS[input.kind];
  const targets = new Map<string, NotificationTarget>();

  const actors = new Set(
    (input.actorEmails ?? []).map((email) => email.trim().toLowerCase()),
  );
  const isActor = (userId: string) => {
    const email = input.userEmails?.[userId]?.trim().toLowerCase();

    return (
      SELF_ACTION_KINDS.has(input.kind) &&
      email !== undefined &&
      email !== "" &&
      actors.has(email)
    );
  };

  function add(target: NotificationTarget) {
    if (target.targetKind === "user" && isActor(target.target)) {
      return;
    }

    const key = `${target.channel}\u0000${target.targetKind}\u0000${target.target}`;

    if (!targets.has(key)) {
      targets.set(key, target);
    }
  }

  for (const channel of input.channels) {
    if (!channel.configured) {
      continue;
    }

    for (const rule of input.rules) {
      if (rule.channel === channel.id && ruleMatches(rule, input)) {
        add({
          channel: channel.id,
          ruleId: rule.id,
          target: rule.destination,
          targetKind: "channel",
        });
      }
    }

    if (!channel.directMessages) {
      continue;
    }

    const wants = (userId: string, scope: "own" | "team", byDefault: boolean) =>
      preferenceFor(input.preferences, userId, channel.id, input.kind, scope) ??
      byDefault;

    if (definition.audience === "admin") {
      for (const adminId of input.adminIds) {
        if (wants(adminId, "own", definition.onByDefault)) {
          add({
            channel: channel.id,
            ruleId: null,
            target: adminId,
            targetKind: "user",
          });
        }
      }

      continue;
    }

    if (!input.envelope) {
      continue;
    }

    if (wants(input.envelope.ownerId, "own", definition.onByDefault)) {
      add({
        channel: channel.id,
        ruleId: null,
        target: input.envelope.ownerId,
        targetKind: "user",
      });
    }

    if (input.envelope.isDraft) {
      continue;
    }

    for (const teammateId of input.teammateIds) {
      if (
        teammateId !== input.envelope.ownerId &&
        wants(teammateId, "team", false)
      ) {
        add({
          channel: channel.id,
          ruleId: null,
          target: teammateId,
          targetKind: "user",
        });
      }
    }
  }

  return [...targets.values()];
}
