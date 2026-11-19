import type { z } from "zod";

import type { IntegrationSettings } from "../integration-settings.ts";
import type { EnvSource } from "../utils/env.ts";
import type { NotificationMessage } from "./message.ts";

// A notification channel: a chat tool notifications can be sent to. Slack
// is the first (slack/channel.ts). Google Chat, Microsoft Teams and plain
// webhooks are listed on the setup page as coming later, and each would
// be one more implementation of NotificationChannel added to the list in
// registry.ts; the outbox, the rules and the preferences already work for
// any channel by its id.
//
// A channel sends to two kinds of place: a person's direct messages, found
// from their email address (lookupUser), and a shared channel or room the
// administrator picked for a rule (an address the tool itself gave).

export type NotificationChannelId =
  "slack" | "google_chat" | "teams" | "webhook";

export type ChannelContext = {
  env: EnvSource;
  stored: IntegrationSettings;
};

/**
 * What a send or a lookup came to. "retry": try again later, after at
 * least `retryAfterSeconds` when the tool said how long. "rate_limited":
 * the tool asked for a pause; nothing more goes to it until then. "auth":
 * the tool refused the credentials, so nothing to it can work until an
 * administrator fixes them. "failed": this message can never go (an
 * unknown channel, say). `error` is a short code, never a response body.
 */
export type ChannelFailure =
  | { error: string; outcome: "auth" }
  | { error: string; outcome: "failed" }
  | { error: string; outcome: "rate_limited"; retryAfterSeconds: number }
  | { error: string; outcome: "retry"; retryAfterSeconds: number | null };

/**
 * The message a later event about the same envelope edits or replies to:
 * the tool's conversation id and the message's own id (Slack's "ts").
 */
export type ThreadRef = { conversation: string; ts: string };

/**
 * How a message is placed.
 *
 * * "standalone": one message, nothing remembered (the install's own
 *   events, tests).
 * * "channel_thread": the first message about an envelope starts a thread;
 *   later ones edit that first message to show where the envelope stands
 *   and reply in its thread.
 * * "in_place": one message per envelope, edited as it moves along.
 * * "new_message": a new message (an outcome that needs attention), and
 *   the in-place message, if there is one, edited to match.
 */
export type MessagePlacement =
  "channel_thread" | "in_place" | "new_message" | "standalone";

export type SendOptions = {
  placement: MessagePlacement;
  /** The remembered message for this envelope and place, if any. */
  thread: ThreadRef | null;
  /** False when the remembered message already shows a newer event. */
  updateThread: boolean;
};

export const STANDALONE: SendOptions = {
  placement: "standalone",
  thread: null,
  updateThread: false,
};

/** `thread`: the message to remember from now on, or null for none. */
export type SendResult =
  { outcome: "sent"; thread: ThreadRef | null } | ChannelFailure;

export type LookupResult =
  | { externalId: string; outcome: "found" }
  | { outcome: "not_found" }
  | ChannelFailure;

export type ChannelStatus = {
  configured: boolean;
  /** Direct messages to people are turned on. */
  directMessages: boolean;
  /** Where the credentials come from: an environment variable wins. */
  source: "env" | "settings" | null;
};

export interface NotificationChannel {
  readonly id: NotificationChannelId;
  readonly name: string;
  /** Checks a rule's destination before it is saved. */
  readonly destinationSchema: z.ZodType<string>;
  status(context: ChannelContext): ChannelStatus;
  lookupUser(email: string, context: ChannelContext): Promise<LookupResult>;
  send(
    destination: string,
    message: NotificationMessage,
    context: ChannelContext,
    options?: SendOptions,
  ): Promise<SendResult>;
}

/** A channel the setup page lists but that cannot be set up yet. */
export type PlannedChannel = {
  description: string;
  id: NotificationChannelId;
  name: string;
};

export const PLANNED_CHANNELS: readonly PlannedChannel[] = [
  {
    description:
      "Messages in a Google Chat space through an incoming webhook or a Chat app.",
    id: "google_chat",
    name: "Google Chat",
  },
  {
    description: "Messages in a Microsoft Teams channel.",
    id: "teams",
    name: "Microsoft Teams",
  },
  {
    description:
      "A signed JSON request to an address of your own, for anything else.",
    id: "webhook",
    name: "Webhook",
  },
];

/** Keeps an error code short and free of anything a tool sent back. */
export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value)
    ? value
    : "unknown_error";
}
