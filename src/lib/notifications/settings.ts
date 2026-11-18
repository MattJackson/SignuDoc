import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import {
  getIntegrationSettings,
  readIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "../integration-settings.ts";
import { getBranding } from "../settings.ts";
import { readEnv, resolveAppUrl, type EnvSource } from "../utils/env.ts";
import {
  PLANNED_CHANNELS,
  type ChannelContext,
  type PlannedChannel,
} from "./channel.ts";
import {
  listNotificationEvents,
  type NotificationEventDefinition,
  type NotificationEventKind,
} from "./events.ts";
import type { NotificationBrand } from "./message.ts";
import { getPreferenceChoices, type PreferenceChoice } from "./preferences.ts";
import { getNotificationChannels } from "./registry.ts";
import { listNotificationRules, type NotificationRule } from "./rules.ts";
import {
  createSlackChannel,
  SLACK_DIRECT_MESSAGES_SETTING,
  SLACK_TOKEN_SETTING,
  slackBotTokenSchema,
} from "./slack/channel.ts";
import type {
  SlackApiError,
  SlackChannelSummary,
  SlackMessageContent,
} from "./slack/client.ts";
import { buildSlackMessage } from "./slack/layout.ts";
import { buildSlackManifest, SLACK_BOT_SCOPES } from "./slack/manifest.ts";
import {
  buildSampleMessage,
  buildSlackPreviews,
  type SlackPreview,
} from "./slack/preview.ts";

// Settings, Notifications: what the administrator sets up (the Slack app,
// direct messages, the job's thresholds and the rules) and the checks they
// can run, and what each person chooses for their own direct messages.

export const DEFAULT_EXPIRING_DAYS = 3;
export const DEFAULT_STUCK_DAYS = 7;
const MAX_THRESHOLD_DAYS = 60;

export type NotificationThresholds = {
  expiringDays: number;
  expiringFromEnv: boolean;
  stuckDays: number;
  stuckFromEnv: boolean;
};

function readDays(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,3}$/.test(value.trim())) {
    return null;
  }

  return Math.min(Number.parseInt(value.trim(), 10), MAX_THRESHOLD_DAYS);
}

/**
 * How many days before a deadline "expiring soon" is, and how many days
 * without activity count as stuck. 0 turns either off. The environment
 * (NOTIFICATION_EXPIRING_DAYS, NOTIFICATION_STUCK_DAYS) wins.
 */
export function readNotificationThresholds(
  env: EnvSource,
  stored: IntegrationSettings,
): NotificationThresholds {
  const expiringEnv = readDays(readEnv(env, "NOTIFICATION_EXPIRING_DAYS"));
  const stuckEnv = readDays(readEnv(env, "NOTIFICATION_STUCK_DAYS"));

  return {
    expiringDays:
      expiringEnv ??
      readDays(stored["notifications.expiringDays"]) ??
      DEFAULT_EXPIRING_DAYS,
    expiringFromEnv: expiringEnv !== null,
    stuckDays:
      stuckEnv ??
      readDays(stored["notifications.stuckDays"]) ??
      DEFAULT_STUCK_DAYS,
    stuckFromEnv: stuckEnv !== null,
  };
}

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAppUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

export type DeliveryStats = {
  /** Held signatures left out because a newer message covered them. */
  combinedLastWeek: number;
  failedLastWeek: number;
  pending: number;
  recentProblems: {
    at: number;
    error: string;
    event: string;
    status: string;
    targetKind: string;
  }[];
  sentLastWeek: number;
  skippedLastWeek: number;
};

async function readDeliveryStats(database: DbExecutor): Promise<DeliveryStats> {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const counts = await queryOne<{
    combined: number;
    failed: number;
    pending: number;
    sent: number;
    skipped: number;
  }>(
    database,
    `
      SELECT
        count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
        count(*) FILTER (WHERE status = 'sent' AND updated_at >= $1)::int AS sent,
        count(*) FILTER (WHERE status = 'failed' AND updated_at >= $1)::int AS failed,
        count(*) FILTER (
          WHERE status = 'skipped' AND updated_at >= $1
            AND last_error IS DISTINCT FROM 'superseded'
        )::int AS skipped,
        count(*) FILTER (
          WHERE status = 'skipped' AND updated_at >= $1
            AND last_error = 'superseded'
        )::int AS combined
      FROM notification_deliveries
    `,
    [since],
  );
  const problems = await queryMany<DeliveryStats["recentProblems"][number]>(
    database,
    `
      SELECT d.updated_at AS at, d.last_error AS error, e.event,
        d.status, d.target_kind AS "targetKind"
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      WHERE d.last_error IS NOT NULL AND d.updated_at >= $1
        AND d.status <> 'sent' AND d.last_error <> 'superseded'
      ORDER BY d.updated_at DESC
      LIMIT 5
    `,
    [since],
  );

  return {
    combinedLastWeek: counts?.combined ?? 0,
    failedLastWeek: counts?.failed ?? 0,
    pending: counts?.pending ?? 0,
    recentProblems: problems,
    sentLastWeek: counts?.sent ?? 0,
    skippedLastWeek: counts?.skipped ?? 0,
  };
}

export type NotificationsAdminView = {
  deliveries: DeliveryStats;
  events: NotificationEventDefinition[];
  planned: PlannedChannel[];
  rules: NotificationRule[];
  siteUrl: string | null;
  slack: {
    configured: boolean;
    directMessages: boolean;
    /** The app's name in Slack: the organization's, or SignuDoc. */
    appName: string;
    /** The app manifest to paste into Slack, as formatted JSON. */
    manifest: string;
    /** A sample of each kind of message, as Slack would show it. */
    previews: SlackPreview[];
    scopes: string[];
    source: "env" | "settings" | null;
  };
  teams: { id: string; name: string }[];
  thresholds: NotificationThresholds;
};

/**
 * The organization's name and logo for messages. `absoluteLogo`: the logo
 * as an https address Slack can fetch, else none; otherwise the path on
 * this site, for a preview in the browser.
 */
async function messageBrand(
  env: EnvSource,
  absoluteLogo: boolean,
): Promise<NotificationBrand & { brandColor: string | null }> {
  const branding = await getBranding(env);
  const base = siteUrl(env);
  let logoUrl = branding.logoUrl;

  if (logoUrl && absoluteLogo) {
    logoUrl = base?.startsWith("https://") ? `${base}${logoUrl}` : null;
  }

  return {
    brandColor: branding.brandColor,
    logoUrl,
    name: branding.organizationName ?? branding.productName,
  };
}

export async function getNotificationsAdminView(
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<NotificationsAdminView> {
  const stored = await readIntegrationSettings(database, env);
  const brand = await messageBrand(env, false);
  const slack = createSlackChannel().status({ env, stored });
  const url = siteUrl(env);
  const [rules, teams, deliveries] = await Promise.all([
    listNotificationRules(database),
    queryMany<{ id: string; name: string }>(
      database,
      `SELECT id, name FROM teams ORDER BY lower(name), id`,
    ),
    readDeliveryStats(database),
  ]);

  return {
    deliveries,
    events: listNotificationEvents(),
    planned: [...PLANNED_CHANNELS],
    rules,
    siteUrl: url,
    slack: {
      appName: brand.name,
      configured: slack.configured,
      directMessages: slack.directMessages,
      manifest: JSON.stringify(
        buildSlackManifest({
          appName: brand.name,
          brandColor: brand.brandColor,
          siteUrl: url,
        }),
        null,
        2,
      ),
      previews: buildSlackPreviews({
        // Without the site's address there would be no buttons to show.
        appUrl: url ?? "https://sign.example.com",
        brand: { logoUrl: brand.logoUrl, name: brand.name },
      }),
      scopes: [...SLACK_BOT_SCOPES],
      source: slack.source,
    },
    teams,
    thresholds: readNotificationThresholds(env, stored),
  };
}

const thresholdSchema = z.number().int().min(0).max(MAX_THRESHOLD_DAYS);

const saveSchema = z.object({
  directMessages: z.boolean().optional(),
  expiringDays: thresholdSchema.optional(),
  removeSlackBotToken: z.boolean().optional(),
  slackBotToken: z.string().max(400).optional(),
  stuckDays: thresholdSchema.optional(),
});

export class NotificationSaveError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "NotificationSaveError";
    this.fieldErrors = fieldErrors;
  }
}

export async function saveNotificationSettings(
  body: unknown,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<NotificationsAdminView> {
  const parsed = saveSchema.safeParse(body);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");

      fieldErrors[field] ??= field.endsWith("Days")
        ? "Use a whole number of days from 0 to 60."
        : "Check this value.";
    }

    throw new NotificationSaveError(
      "Check the highlighted fields.",
      fieldErrors,
    );
  }

  const input = parsed.data;
  const update: IntegrationSettingsUpdate = {};

  if (input.slackBotToken !== undefined && input.slackBotToken.trim()) {
    const token = slackBotTokenSchema.safeParse(input.slackBotToken);

    if (!token.success) {
      throw new NotificationSaveError("Check the bot token.", {
        slackBotToken: token.error.issues[0]?.message ?? "Check the token.",
      });
    }

    update[SLACK_TOKEN_SETTING] = token.data;
  } else if (input.removeSlackBotToken) {
    update[SLACK_TOKEN_SETTING] = null;
  }

  if (input.directMessages !== undefined) {
    update[SLACK_DIRECT_MESSAGES_SETTING] = input.directMessages ? null : "off";
  }

  if (input.expiringDays !== undefined) {
    update["notifications.expiringDays"] = String(input.expiringDays);
  }

  if (input.stuckDays !== undefined) {
    update["notifications.stuckDays"] = String(input.stuckDays);
  }

  const tokenChange = update[SLACK_TOKEN_SETTING];
  const previousToken =
    tokenChange === undefined
      ? undefined
      : (await getIntegrationSettings(env))[SLACK_TOKEN_SETTING];

  await saveIntegrationSettings(update, actor, { area: "notifications", env });

  // The people and messages remembered belong to the workspace the old
  // token was for; a new token may be for another one.
  if (
    tokenChange !== undefined &&
    (tokenChange ?? undefined) !== previousToken
  ) {
    const database = getDb();

    await database.query(
      `DELETE FROM notification_identities WHERE channel = 'slack'`,
    );
    await database.query(
      `DELETE FROM notification_threads WHERE channel = 'slack'`,
    );
  }

  return getNotificationsAdminView(env);
}

// Plain words for what Slack said, from its error code alone.
const SLACK_ERROR_WORDS: Record<string, string> = {
  account_inactive: "The token belongs to an app or user that was deactivated.",
  channel_not_found:
    "Slack has no channel with that ID that the app can see. For a private channel, invite the app first.",
  invalid_auth:
    "Slack did not accept the token. Paste the Bot User OAuth Token again.",
  is_archived: "That channel is archived.",
  missing_scope:
    "The app is missing a permission. Recreate it from the manifest above, or add the scopes listed there, and reinstall it.",
  not_authed: "No token was sent.",
  not_in_channel:
    "The app is not in that channel. In Slack, open the channel and type /invite @ followed by the app's name.",
  not_configured: "Slack is not set up yet.",
  ratelimited: "Slack asked to slow down. Try again in a minute.",
  token_revoked:
    "The token was revoked. Reinstall the app and paste the new token.",
  invalid_response: "Slack sent back something that could not be read.",
  network_error: "Slack could not be reached. Check the network and try again.",
  timeout: "Slack did not answer in time. Try again in a minute.",
  users_not_found:
    "Slack has nobody with your email address. Your Slack account needs the same address as this one.",
};

export function describeSlackError(code: string): string {
  const status = /^http_(\d{3})$/.exec(code);

  if (status) {
    return `Slack could not be reached properly (HTTP ${status[1] ?? ""}).`;
  }

  return SLACK_ERROR_WORDS[code] ?? `Slack answered with the error "${code}".`;
}

export type SlackCheckResult = {
  message: string;
  ok: boolean;
};

async function slackContext(env: EnvSource): Promise<ChannelContext> {
  return { env, stored: await getIntegrationSettings(env) };
}

function failure(error: SlackApiError): SlackCheckResult {
  return { message: describeSlackError(error.error), ok: false };
}

/** "Test connection": asks Slack who the token belongs to. */
export async function testSlackConnection(
  env: EnvSource = process.env,
): Promise<SlackCheckResult> {
  const slack = createSlackChannel().client(await slackContext(env));

  if (!slack) {
    return { message: describeSlackError("not_configured"), ok: false };
  }

  const result = await slack.authTest();

  if (!result.ok) {
    return failure(result);
  }

  return {
    message: `Connected to the ${result.team ?? "Slack"} workspace.`,
    ok: true,
  };
}

/** Lists the public channels, for picking one in a rule. */
export async function listSlackChannels(
  env: EnvSource = process.env,
): Promise<
  | { channels: SlackChannelSummary[]; ok: true }
  | (SlackCheckResult & { ok: false })
> {
  const slack = createSlackChannel().client(await slackContext(env));

  if (!slack) {
    return { message: describeSlackError("not_configured"), ok: false };
  }

  const channels: SlackChannelSummary[] = [];
  let cursor: string | null = null;

  // Five pages of 200 are enough to pick from; a larger workspace can
  // paste a channel's ID.
  for (let page = 0; page < 5; page += 1) {
    const result = await slack.listChannels(cursor);

    if (!result.ok) {
      return { message: describeSlackError(result.error), ok: false };
    }

    channels.push(...result.channels);
    cursor = result.nextCursor;

    if (!cursor) {
      break;
    }
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));

  return { channels, ok: true };
}

/**
 * A test message: a sample of `kind` as the real ones look, marked as a
 * test, with one button to this site instead of a made-up envelope's.
 */
export function buildSlackTestMessage(
  kind: NotificationEventKind,
  { appUrl, brand }: { appUrl: string | null; brand: NotificationBrand },
): SlackMessageContent {
  const sample = buildSampleMessage(kind, { appUrl, brand });
  const content = buildSlackMessage(
    {
      ...sample,
      actions: appUrl
        ? [
            {
              id: "open",
              label: `Open ${brand.name}`,
              url: `${appUrl.replace(/\/+$/, "")}/dashboard`,
            },
          ]
        : [],
    },
    "message",
  );
  const note =
    "Test message from Settings, Notifications. Nothing happened to a real envelope.";

  return {
    ...content,
    blocks: [
      ...(content.blocks ?? []),
      { elements: [{ text: note, type: "mrkdwn" }], type: "context" },
    ],
    text: `${note} ${content.text}`,
  };
}

/**
 * Sends a test message to a channel, or to the person asking (found by
 * their email address), so the setup can be seen to work.
 */
export async function sendSlackTestMessage(
  to: { channel: string } | { email: string },
  env: EnvSource = process.env,
  kind: NotificationEventKind = "envelope_completed",
): Promise<SlackCheckResult> {
  const slack = createSlackChannel().client(await slackContext(env));

  if (!slack) {
    return { message: describeSlackError("not_configured"), ok: false };
  }

  let destination: string;

  if ("email" in to) {
    const user = await slack.lookupUserByEmail(to.email);

    if (!user.ok) {
      return failure(user);
    }

    destination = user.userId;
  } else {
    destination = to.channel;
  }

  const brand = await messageBrand(env, true);
  const result = await slack.postMessage({
    ...buildSlackTestMessage(kind, {
      appUrl: siteUrl(env),
      brand: { logoUrl: brand.logoUrl, name: brand.name },
    }),
    channel: destination,
  });

  return result.ok
    ? { message: "Sent. Look for it in Slack.", ok: true }
    : failure(result);
}

/**
 * A rule's "Send test": a sample of the first event the rule names, posted
 * to its channel. Null when there is no such rule.
 */
export async function sendSlackRuleTest(
  ruleId: string,
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<SlackCheckResult | null> {
  const rule = (await listNotificationRules(database)).find(
    (item) => item.id === ruleId,
  );

  if (!rule) {
    return null;
  }

  if (rule.channel !== "slack") {
    return { message: "Only Slack rules can be tested here.", ok: false };
  }

  const result = await sendSlackTestMessage(
    { channel: rule.destination },
    env,
    rule.events[0] ?? "envelope_completed",
  );
  const where = rule.destinationName
    ? `#${rule.destinationName}`
    : rule.destination;

  return result.ok
    ? { message: `Sent a test message to ${where}.`, ok: true }
    : result;
}

export type NotificationPreferencesView = {
  channels: {
    /** Direct messages can reach this person on this channel now. */
    available: boolean;
    choices: PreferenceChoice[];
    id: string;
    name: string;
  }[];
  events: NotificationEventDefinition[];
  /** On at least one team, so the "my teams' envelopes" column means something. */
  onTeam: boolean;
};

export async function getNotificationPreferencesView(
  userId: string,
  isAdmin: boolean,
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<NotificationPreferencesView> {
  const stored = await getIntegrationSettings(env);
  const team = await queryOne<{ one: number }>(
    database,
    `SELECT 1 AS one FROM team_members WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

  return {
    channels: await Promise.all(
      getNotificationChannels().map(async (channel) => {
        const status = channel.status({ env, stored });

        return {
          available: status.configured && status.directMessages,
          choices: await getPreferenceChoices(
            userId,
            channel.id,
            isAdmin,
            database,
          ),
          id: channel.id,
          name: channel.name,
        };
      }),
    ),
    events: listNotificationEvents(),
    onTeam: team !== null,
  };
}
