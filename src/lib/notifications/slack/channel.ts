import { z } from "zod";

import type { IntegrationSettings } from "../../integration-settings.ts";
import { readEnv, type EnvSource } from "../../utils/env.ts";
import type {
  ChannelContext,
  ChannelStatus,
  LookupResult,
  NotificationChannel,
  SendResult,
} from "../channel.ts";
import type { NotificationMessage } from "../message.ts";
import {
  classifySlackError,
  createSlackClient,
  type SlackBlock,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";

// Slack as a notification channel. The administrator creates a Slack app
// from the manifest on the setup page (manifest.ts), installs it in their
// workspace and pastes its bot token here; SLACK_BOT_TOKEN, when set, wins.
// Direct messages go to the person whose Slack account has the same email
// address as their account here; rules post to channels the app was
// invited to.

export const SLACK_TOKEN_SETTING = "slack.botToken";
export const SLACK_DIRECT_MESSAGES_SETTING =
  "notifications.slack.directMessages";

export const slackBotTokenSchema = z
  .string()
  .trim()
  .regex(
    /^xoxb-[A-Za-z0-9-]{10,250}$/,
    "Paste the app's Bot User OAuth Token. It starts with xoxb-.",
  );

// A channel's id as Slack shows it under "About" (C..., or G... for an
// older private channel).
export const slackChannelIdSchema = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{6,20}$/, "Pick a channel, or paste its ID (C0123...).");

export function resolveSlackToken(
  env: EnvSource,
  stored: IntegrationSettings,
): { source: "env" | "settings"; token: string } | null {
  const fromEnv = readEnv(env, "SLACK_BOT_TOKEN");

  if (fromEnv) {
    return { source: "env", token: fromEnv };
  }

  const saved = stored[SLACK_TOKEN_SETTING];

  return saved ? { source: "settings", token: saved } : null;
}

/** Keeps Slack from reading a title or a name as a link or a mention. */
export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The Block Kit layout of a message: headline, facts, a button. */
export function buildSlackBlocks(message: NotificationMessage): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      text: { text: `*${escapeSlackText(message.headline)}*`, type: "mrkdwn" },
      type: "section",
    },
  ];

  if (message.fields.length > 0) {
    blocks.push({
      elements: [
        {
          text: message.fields
            .map(
              (field) =>
                `*${escapeSlackText(field.label)}:* ${escapeSlackText(field.value)}`,
            )
            .join("   "),
          type: "mrkdwn",
        },
      ],
      type: "context",
    });
  }

  if (message.link) {
    blocks.push({
      elements: [
        {
          action_id: "open",
          text: { text: message.link.label, type: "plain_text" },
          type: "button",
          url: message.link.url,
        },
      ],
      type: "actions",
    });
  }

  return blocks;
}

export function createSlackChannel({
  clientFor = (token: string) => createSlackClient({ token }),
}: {
  clientFor?: (token: string) => SlackClient;
} = {}): NotificationChannel & {
  client(context: ChannelContext): SlackClient | null;
} {
  function client(context: ChannelContext): SlackClient | null {
    const resolved = resolveSlackToken(context.env, context.stored);

    return resolved ? clientFor(resolved.token) : null;
  }

  return {
    client,
    destinationSchema: slackChannelIdSchema,
    id: "slack",

    async lookupUser(email, context): Promise<LookupResult> {
      const slack = client(context);

      if (!slack) {
        return { error: "not_configured", outcome: "failed" };
      }

      const result = await slack.lookupUserByEmail(email);

      if (result.ok) {
        return { externalId: result.userId, outcome: "found" };
      }

      if (result.error === "users_not_found") {
        return { outcome: "not_found" };
      }

      return classifySlackError(result);
    },

    name: "Slack",

    async send(destination, message, context): Promise<SendResult> {
      const slack = client(context);

      if (!slack) {
        return { error: "not_configured", outcome: "failed" };
      }

      const result = await slack.postMessage({
        blocks: buildSlackBlocks(message),
        channel: destination,
        text: escapeSlackText(message.text),
      });

      return result.ok ? { outcome: "sent" } : classifySlackError(result);
    },

    status(context): ChannelStatus {
      const resolved = resolveSlackToken(context.env, context.stored);

      return {
        configured: resolved !== null,
        directMessages:
          resolved !== null &&
          context.stored[SLACK_DIRECT_MESSAGES_SETTING] !== "off",
        source: resolved?.source ?? null,
      };
    },
  };
}

/** For tests: the same channel with a fake fetch. */
export function createSlackChannelWithFetch(fetch: SlackFetch) {
  return createSlackChannel({
    clientFor: (token) => createSlackClient({ fetch, token }),
  });
}
