import { z } from "zod";

import { getSignInConfig } from "./auth/sign-in-settings.ts";
import { type DbPool, getDb, queryMany } from "./db/connection.ts";
import { readDirectorySyncSetting } from "./directory-sync.ts";
import {
  googleSigningModes,
  readGoogleSigningSetting,
  resolveGoogleSigningPolicy,
  type GoogleSigningMode,
} from "./google-signing.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "./integration-settings.ts";
import { readDirectoryConfig } from "./integrations/google/directory.ts";
import {
  managerPolicyModes,
  readManagerPolicy,
  type ManagerPolicyMode,
} from "./manager-policy.ts";
import { isMissingSchemaError, readStoredSettings } from "./settings.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// The people settings an administrator chooses, in Settings, Google
// Workspace, and in the same step of onboarding: the rule about the
// sender's manager approving first (manager-policy.ts), employees signing
// with Google (google-signing.ts), and the offboarding check against the
// directory (directory-sync.ts). Each is off until it is turned on, and an
// environment variable that sets the same thing wins and locks it.

export type PeopleSettingsView = {
  directory: {
    /** The Workspace directory is turned on, which two of these need. */
    enabled: boolean;
  };
  directorySync: { enabled: boolean; fromEnv: boolean };
  googleSigning: {
    /** Google sign-in is set up and the Workspace domains are known. */
    available: boolean;
    domains: string[];
    fromEnv: boolean;
    mode: GoogleSigningMode;
  };
  managerPolicy: {
    fromEnv: boolean;
    mode: ManagerPolicyMode;
    teamIds: string[];
  };
  /** Part 11 mode has no approvers, so the manager rule does not apply. */
  part11Mode: boolean;
  teams: Array<{ id: string; name: string }>;
};

export class PeopleSettingsError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "PeopleSettingsError";
  }
}

export async function getPeopleSettingsView({
  database = getDb(),
  env = process.env,
}: { database?: DbPool; env?: EnvSource } = {}): Promise<PeopleSettingsView> {
  const [stored, signIn, settings, teams] = await Promise.all([
    getIntegrationSettings(env),
    getSignInConfig(env),
    readStoredSettings(database),
    queryMany<{ id: string; name: string }>(
      database,
      `SELECT id, name FROM teams ORDER BY lower(name), id`,
    ).catch((error: unknown) => {
      // Only a missing teams table (a database not yet migrated) is no teams.
      if (isMissingSchemaError(error)) {
        return [];
      }

      throw error;
    }),
  ]);
  const managerPolicy = readManagerPolicy(env, stored);
  const googleSigning = resolveGoogleSigningPolicy(
    signIn,
    readGoogleSigningSetting(env, stored),
  );

  return {
    directory: { enabled: readDirectoryConfig(env, stored).enabled },
    directorySync: {
      enabled: readDirectorySyncSetting(env, stored).enabled,
      fromEnv: Boolean(readEnv(env, "DIRECTORY_SYNC")),
    },
    googleSigning: {
      available: googleSigning.available,
      domains: googleSigning.domains,
      fromEnv: googleSigning.source === "env",
      mode: googleSigning.mode,
    },
    managerPolicy: {
      fromEnv: managerPolicy.source === "env",
      mode: managerPolicy.mode,
      // Only teams that still exist.
      teamIds: managerPolicy.teamIds.filter((id) =>
        teams.some((team) => team.id === id),
      ),
    },
    part11Mode: settings?.part11Mode ?? false,
    teams,
  };
}

const peopleSettingsSchema = z.object({
  directorySync: z.boolean().optional(),
  googleSigning: z.enum(googleSigningModes).optional(),
  managerPolicy: z.enum(managerPolicyModes).optional(),
  managerPolicyTeamIds: z
    .array(z.string().trim().min(1).max(200))
    .max(200)
    .optional(),
});

/**
 * Saves what an administrator changed. A setting an environment variable
 * fixes is refused rather than stored, since the stored value would not be
 * the one in force. Every change is recorded in the install's audit trail
 * by saveIntegrationSettings.
 */
export async function savePeopleSettings(
  rawInput: unknown,
  actor: IntegrationSettingsActor,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbPool; env?: EnvSource } = {},
): Promise<PeopleSettingsView> {
  const parsed = peopleSettingsSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new PeopleSettingsError("Check what was chosen.");
  }

  const input = parsed.data;
  const update: IntegrationSettingsUpdate = {};

  if (input.managerPolicy !== undefined) {
    if (readEnv(env, "MANAGER_APPROVAL")) {
      throw new PeopleSettingsError(
        "MANAGER_APPROVAL is set in the environment, so the manager rule is fixed there.",
      );
    }

    update["people.managerPolicy"] =
      input.managerPolicy === "off" ? null : input.managerPolicy;
  }

  if (input.managerPolicyTeamIds !== undefined) {
    const known = new Set(
      (await queryMany<{ id: string }>(database, `SELECT id FROM teams`)).map(
        (team) => team.id,
      ),
    );
    const teamIds = [...new Set(input.managerPolicyTeamIds)];

    if (teamIds.some((id) => !known.has(id) || id.includes(","))) {
      throw new PeopleSettingsError(
        "One of the chosen teams no longer exists. Reload the page.",
      );
    }

    update["people.managerPolicyTeams"] = teamIds.join(",") || null;
  }

  if (input.googleSigning !== undefined) {
    if (readEnv(env, "GOOGLE_SIGNING")) {
      throw new PeopleSettingsError(
        "GOOGLE_SIGNING is set in the environment, so this is fixed there.",
      );
    }

    update["people.googleSigning"] =
      input.googleSigning === "off" ? null : input.googleSigning;
  }

  if (input.directorySync !== undefined) {
    if (readEnv(env, "DIRECTORY_SYNC")) {
      throw new PeopleSettingsError(
        "DIRECTORY_SYNC is set in the environment, so this is fixed there.",
      );
    }

    update["people.directorySync"] = input.directorySync ? "on" : null;
  }

  await saveIntegrationSettings(update, actor, {
    area: "people",
    database,
    env,
  });

  return getPeopleSettingsView({ database, env });
}
