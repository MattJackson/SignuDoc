import { z } from "zod";

import type { IntegrationSettings } from "../../integration-settings.ts";
import { readEnv, type EnvSource } from "../../utils/env.ts";
import {
  STANDALONE,
  type ChannelContext,
  type ChannelStatus,
  type LookupResult,
  type NotificationChannel,
  type SendOptions,
  type SendResult,
  type ThreadRef,
} from "../channel.ts";
import type { NotificationMessage } from "../message.ts";
import {
  classifySlackError,
  createSlackClient,
  SLACK_MESSAGE_GONE_ERRORS,
  type SlackApiError,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";
import { buildSlackMessage, escapeSlackText } from "./layout.ts";

export { escapeSlackText };

// Slack as a notification channel. The administrator creates a Slack app
// from the manifest on the setup page (manifest.ts), installs it in their
// workspace and pastes its bot token here; SLACK_BOT_TOKEN, when set, wins.
// Direct messages go to the person whose Slack account has the same email
// address as their account here; rules post to channels the app was
// invited to.
//
// One message per envelope per place (see SendOptions in ../channel.ts):
// in a channel, the first message starts a thread, and each later event
// edits it (chat.update) to show where the envelope stands and replies in
// its thread; in direct messages, progress edits one message and outcomes
// post a new one. A remembered message that was deleted is replaced by a
// new one.

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

function isGone(error: SlackApiError): boolean {
  return SLACK_MESSAGE_GONE_ERRORS.has(error.error);
}

/**
 * Sends one notification to Slack, placed as `options` says. Returns the
 * message to remember for this envelope and place from now on.
 */
export async function sendSlackNotification(
  slack: SlackClient,
  destination: string,
  message: NotificationMessage,
  { placement, thread, updateThread }: SendOptions,
): Promise<SendResult> {
  const content = buildSlackMessage(message, "message");

  async function post(): Promise<
    { ok: true; ref: ThreadRef } | { failure: SlackApiError; ok: false }
  > {
    const result = await slack.postMessage({
      ...content,
      channel: destination,
    });

    return result.ok
      ? { ok: true, ref: { conversation: result.channel, ts: result.ts } }
      : { failure: result, ok: false };
  }

  /** Edits the remembered message. "gone": it no longer exists. */
  async function edit(
    ref: ThreadRef,
  ): Promise<"edited" | "gone" | SlackApiError> {
    const result = await slack.updateMessage({
      ...content,
      channel: ref.conversation,
      ts: ref.ts,
    });

    if (result.ok) {
      return "edited";
    }

    return isGone(result) ? "gone" : result;
  }

  switch (placement) {
    case "standalone": {
      const posted = await post();

      return posted.ok
        ? { outcome: "sent", thread: null }
        : classifySlackError(posted.failure);
    }

    case "in_place":
    case "channel_thread": {
      if (thread) {
        // The first message is edited before the reply is posted: a retry
        // after a failed reply edits it again (harmless) rather than
        // posting the reply twice.
        const edited = updateThread ? await edit(thread) : "edited";

        if (edited === "edited") {
          if (placement === "in_place") {
            return { outcome: "sent", thread };
          }

          const reply = await slack.postMessage({
            ...buildSlackMessage(message, "reply"),
            channel: thread.conversation,
            threadTs: thread.ts,
          });

          if (reply.ok) {
            return { outcome: "sent", thread };
          }

          if (!isGone(reply)) {
            return classifySlackError(reply);
          }
        } else if (edited !== "gone") {
          return classifySlackError(edited);
        }
      }

      // No message yet, or it was deleted: this one becomes it.
      const posted = await post();

      return posted.ok
        ? { outcome: "sent", thread: posted.ref }
        : classifySlackError(posted.failure);
    }

    case "new_message": {
      let kept = thread;

      if (thread && updateThread) {
        const edited = await edit(thread);

        if (edited === "gone") {
          kept = null;
        } else if (edited !== "edited") {
          return classifySlackError(edited);
        }
      }

      const posted = await post();

      return posted.ok
        ? { outcome: "sent", thread: kept }
        : classifySlackError(posted.failure);
    }
  }
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
    async send(
      destination,
      message,
      context,
      options = STANDALONE,
    ): Promise<SendResult> {
      const slack = client(context);

      if (!slack) {
        return { error: "not_configured", outcome: "failed" };
      }

      return sendSlackNotification(slack, destination, message, options);
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
