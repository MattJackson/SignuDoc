import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import type { IntegrationSettingsActor } from "../integration-settings.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import {
  NOTIFICATION_EVENTS,
  notificationEventKinds,
  type NotificationEventKind,
} from "./events.ts";
import { getNotificationChannel } from "./registry.ts";
import type { NotificationRuleRecord } from "./targets.ts";

// An administrator's rules: "these events go to this channel", for every
// envelope or for one team's. Each change is recorded in the install's
// audit trail in the same transaction, as a change of settings.

export const MAX_NOTIFICATION_RULES = 100;

export class NotificationSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode = 400,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "NotificationSettingsError";
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

export type NotificationRule = NotificationRuleRecord & {
  destinationName: string | null;
  events: NotificationEventKind[];
  teamName: string | null;
};

const ruleInputSchema = z.object({
  channel: z.string().trim().min(1).max(40),
  destination: z.string().trim().min(1).max(200),
  destinationName: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value ? value.replace(/^#/, "") : null)),
  enabled: z.boolean().optional(),
  events: z
    .array(z.enum(notificationEventKinds))
    .min(1, "Choose at least one event.")
    .max(notificationEventKinds.length),
  teamId: z.string().trim().min(1).max(100).nullish(),
});

export type NotificationRuleInput = z.input<typeof ruleInputSchema>;

type RuleRow = {
  channel: string;
  destination: string;
  destinationName: string | null;
  enabled: boolean;
  events: string[];
  id: string;
  teamId: string | null;
  teamName: string | null;
};

function toRule(row: RuleRow): NotificationRule {
  return {
    ...row,
    events: row.events.filter((event): event is NotificationEventKind =>
      (notificationEventKinds as readonly string[]).includes(event),
    ),
  };
}

export async function listNotificationRules(
  database: DbExecutor = getDb(),
): Promise<NotificationRule[]> {
  const rows = await queryMany<RuleRow>(
    database,
    `
      SELECT
        r.id,
        r.channel,
        r.events,
        r.team_id AS "teamId",
        t.name AS "teamName",
        r.destination,
        r.destination_name AS "destinationName",
        r.enabled
      FROM notification_rules r
      LEFT JOIN teams t ON t.id = r.team_id
      ORDER BY r.created_at ASC, r.id ASC
    `,
  );

  return rows.map(toRule);
}

function parseRuleInput(body: unknown) {
  const parsed = ruleInputSchema.safeParse(body);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "rule");

      fieldErrors[field] ??= issue.message;
    }

    throw new NotificationSettingsError("Check the rule.", 400, fieldErrors);
  }

  const input = parsed.data;
  const channel = getNotificationChannel(input.channel);

  if (!channel) {
    throw new NotificationSettingsError(
      "That channel cannot be used yet.",
      400,
      {
        channel: "That channel cannot be used yet.",
      },
    );
  }

  const destination = channel.destinationSchema.safeParse(input.destination);

  if (!destination.success) {
    throw new NotificationSettingsError("Check the rule.", 400, {
      destination:
        destination.error.issues[0]?.message ?? "Check the destination.",
    });
  }

  const teamId = input.teamId ?? null;

  if (
    teamId !== null &&
    input.events.some(
      (event) => NOTIFICATION_EVENTS[event].audience === "admin",
    )
  ) {
    throw new NotificationSettingsError("Check the rule.", 400, {
      events:
        "A team's channel only hears about that team's envelopes. Send backup failures to a rule for every envelope.",
    });
  }

  return {
    channel: channel.id,
    destination: destination.data,
    destinationName: input.destinationName,
    enabled: input.enabled ?? true,
    events: [...new Set(input.events)],
    teamId,
  };
}

async function requireTeam(database: DbExecutor, teamId: string | null) {
  if (teamId === null) {
    return;
  }

  const team = await queryOne<{ id: string }>(
    database,
    `SELECT id FROM teams WHERE id = $1`,
    [teamId],
  );

  if (!team) {
    throw new NotificationSettingsError("Check the rule.", 400, {
      teamId: "That team no longer exists.",
    });
  }
}

async function recordRuleChange(
  database: DbExecutor,
  actor: IntegrationSettingsActor,
  change: Record<string, unknown>,
) {
  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event: "settings_changed",
      ipAddress: actor.ipAddress ?? null,
      metadata: { area: "notification_rules", ...change },
      userAgent: actor.userAgent ?? null,
    },
    database,
  );
}

export async function createNotificationRule(
  actor: IntegrationSettingsActor,
  body: unknown,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  const input = parseRuleInput(body);

  await withTransaction(async (tx) => {
    await requireTeam(tx, input.teamId);

    const count = await queryOne<{ count: number }>(
      tx,
      `SELECT count(*)::int AS count FROM notification_rules`,
    );

    if ((count?.count ?? 0) >= MAX_NOTIFICATION_RULES) {
      throw new NotificationSettingsError(
        `An install can have up to ${String(MAX_NOTIFICATION_RULES)} rules.`,
      );
    }

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await tx.query(
      `
        INSERT INTO notification_rules (
          id, channel, events, team_id, destination, destination_name,
          enabled, created_at, updated_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
      `,
      [
        id,
        input.channel,
        input.events,
        input.teamId,
        input.destination,
        input.destinationName,
        input.enabled,
        now,
        actor.id,
      ],
    );
    await recordRuleChange(tx, actor, { created: { id, ...input } });
  }, database);

  return listNotificationRules(database);
}

export async function updateNotificationRule(
  actor: IntegrationSettingsActor,
  id: string,
  body: unknown,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  const input = parseRuleInput(body);

  await withTransaction(async (tx) => {
    await requireTeam(tx, input.teamId);

    const before = await queryOne<RuleRow>(
      tx,
      `
        SELECT id, channel, events, team_id AS "teamId", NULL AS "teamName",
          destination, destination_name AS "destinationName", enabled
        FROM notification_rules WHERE id = $1 FOR UPDATE
      `,
      [id],
    );

    if (!before) {
      throw new NotificationSettingsError("That rule no longer exists.", 404);
    }

    await tx.query(
      `
        UPDATE notification_rules SET
          channel = $2, events = $3, team_id = $4, destination = $5,
          destination_name = $6, enabled = $7, updated_at = $8
        WHERE id = $1
      `,
      [
        id,
        input.channel,
        input.events,
        input.teamId,
        input.destination,
        input.destinationName,
        input.enabled,
        Math.floor(Date.now() / 1000),
      ],
    );

    await recordRuleChange(tx, actor, {
      updated: {
        from: {
          channel: before.channel,
          destination: before.destination,
          destinationName: before.destinationName,
          enabled: before.enabled,
          events: before.events,
          teamId: before.teamId,
        },
        id,
        to: input,
      },
    });
  }, database);

  return listNotificationRules(database);
}

export async function deleteNotificationRule(
  actor: IntegrationSettingsActor,
  id: string,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  await withTransaction(async (tx) => {
    const deleted = await tx.query(
      `DELETE FROM notification_rules WHERE id = $1`,
      [id],
    );

    if (deleted.rowCount !== 1) {
      throw new NotificationSettingsError("That rule no longer exists.", 404);
    }

    await recordRuleChange(tx, actor, { deleted: { id } });
  }, database);

  return listNotificationRules(database);
}
