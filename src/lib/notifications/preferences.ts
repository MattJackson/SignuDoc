import { z } from "zod";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import {
  listNotificationEvents,
  notificationEventKinds,
  type NotificationEventKind,
} from "./events.ts";
import type { NotificationPreferenceRecord } from "./targets.ts";

// What a person chose for their own direct messages, per channel and
// event: for the envelopes they sent ("own") and for their teammates'
// ("team"). Only choices that differ from the default are worth a row, but
// a row that matches the default is harmless; saving writes what was sent.

export type PreferenceChoice = {
  enabled: boolean;
  event: NotificationEventKind;
  scope: "own" | "team";
};

export const preferenceUpdateSchema = z.object({
  channel: z.string().trim().min(1).max(40),
  preferences: z
    .array(
      z.object({
        enabled: z.boolean(),
        event: z.enum(notificationEventKinds),
        scope: z.enum(["own", "team"]),
      }),
    )
    .max(notificationEventKinds.length * 2),
});

export async function listPreferencesForUsers(
  userIds: string[],
  database: DbExecutor = getDb(),
): Promise<NotificationPreferenceRecord[]> {
  if (userIds.length === 0) {
    return [];
  }

  return queryMany<NotificationPreferenceRecord>(
    database,
    `
      SELECT user_id AS "userId", channel, event, scope, enabled
      FROM notification_preferences
      WHERE user_id = ANY($1)
    `,
    [userIds],
  );
}

/**
 * Every choice a person can make on one channel, with what applies now:
 * theirs where they made one, the default otherwise. Administrators also
 * see the install's own events; others do not.
 */
export async function getPreferenceChoices(
  userId: string,
  channel: string,
  isAdmin: boolean,
  database: DbExecutor = getDb(),
): Promise<PreferenceChoice[]> {
  const stored = await listPreferencesForUsers([userId], database);
  const choices: PreferenceChoice[] = [];

  for (const definition of listNotificationEvents()) {
    const scopes: ("own" | "team")[] =
      definition.audience === "admin"
        ? isAdmin
          ? ["own"]
          : []
        : ["own", "team"];

    for (const scope of scopes) {
      const found = stored.find(
        (row) =>
          row.channel === channel &&
          row.event === definition.kind &&
          row.scope === scope,
      );

      choices.push({
        enabled:
          found?.enabled ?? (scope === "own" ? definition.onByDefault : false),
        event: definition.kind,
        scope,
      });
    }
  }

  return choices;
}

export async function savePreferenceChoices(
  userId: string,
  body: unknown,
  isAdmin: boolean,
  database: DbPool = getDb(),
): Promise<PreferenceChoice[] | null> {
  const parsed = preferenceUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const { channel, preferences } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const allowed = new Set(
    (await getPreferenceChoices(userId, channel, isAdmin, database)).map(
      (choice) => `${choice.event}:${choice.scope}`,
    ),
  );

  await withTransaction(async (tx) => {
    for (const preference of preferences) {
      if (!allowed.has(`${preference.event}:${preference.scope}`)) {
        continue;
      }

      await tx.query(
        `
          INSERT INTO notification_preferences (
            user_id, channel, event, scope, enabled, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, channel, event, scope) DO UPDATE SET
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `,
        [
          userId,
          channel,
          preference.event,
          preference.scope,
          preference.enabled,
          now,
        ],
      );
    }
  }, database);

  return getPreferenceChoices(userId, channel, isAdmin, database);
}
