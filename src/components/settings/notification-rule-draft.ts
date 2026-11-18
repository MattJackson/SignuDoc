import type { NotificationEventKind } from "../../lib/notifications/events.ts";

// The Slack rule form's draft, and the request body saved from it.

export type RuleDraft = {
  destination: string;
  destinationName: string;
  events: NotificationEventKind[];
  enabled: boolean;
  id: string | null;
  teamId: string;
};

export const EMPTY_RULE: RuleDraft = {
  destination: "",
  destinationName: "",
  enabled: true,
  events: ["envelope_completed", "envelope_declined"],
  id: null,
  teamId: "",
};

export function draftFromRule(rule: {
  destination: string;
  destinationName: string | null;
  enabled?: boolean;
  events: NotificationEventKind[];
  id: string;
  teamId: string | null;
}): RuleDraft {
  return {
    destination: rule.destination,
    destinationName: rule.destinationName ?? "",
    enabled: rule.enabled ?? true,
    events: rule.events,
    id: rule.id,
    teamId: rule.teamId ?? "",
  };
}

export function ruleBody(draft: RuleDraft) {
  return {
    channel: "slack",
    destination: draft.destination,
    destinationName: draft.destinationName || null,
    enabled: draft.enabled,
    events: draft.events,
    teamId: draft.teamId || null,
  };
}
