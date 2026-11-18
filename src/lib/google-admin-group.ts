import { getIntegrationSettings } from "./integration-settings.ts";
import {
  getDirectoryClient,
  type DirectoryClient,
} from "./integrations/google/directory.ts";
import { logSecurityEvent } from "./security/logging.ts";
import { normalizeEmailDomain } from "./signup-policy.ts";
import {
  setPersonRoleFromDirectory,
  type DirectoryRoleResult,
} from "./people.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// A Google Group whose members are this install's administrators. When it
// is set (GOOGLE_ADMIN_GROUP, or Settings, Google Workspace) and the
// Workspace directory can be read, each single sign-on sign-in brings the
// account's role in line with the group: a member becomes an administrator,
// and an administrator who has left the group stops being one.
//
// - Membership counts through nested groups too (the directory's hasMember).
// - The last administrator is never removed (people.ts), so a group emptied
//   by mistake cannot leave the install with none.
// - If the directory cannot be asked, nothing changes: a failed lookup is
//   not taken as "not a member".
// - Password sign-ins are not synced, so the break-glass administrator kept
//   for when the identity provider is down keeps the role.
// - Every change is in the site audit trail as a role change, naming the
//   group.

export type AdminGroupSetting = {
  group: string | null;
  /** Why a value that is set could not be used, when it could not. */
  problem?: string;
  source: "env" | "none" | "settings";
};

const warned = new Set<string>();

function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[auth] ${message}`);
  }
}

/** A group is named by its email address, like admins@example.com. */
export function normalizeGroupAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");

  if (at <= 0 || !normalizeEmailDomain(trimmed.slice(at + 1))) {
    return null;
  }

  return /^[a-z0-9._%+'-]+$/.test(trimmed.slice(0, at)) ? trimmed : null;
}

export function readAdminGroup(
  env: EnvSource = process.env,
  stored: Readonly<Partial<Record<"google.adminGroup", string>>> | null = null,
): AdminGroupSetting {
  const fromEnv = readEnv(env, "GOOGLE_ADMIN_GROUP");

  if (fromEnv) {
    const group = normalizeGroupAddress(fromEnv);

    if (!group) {
      const problem =
        "GOOGLE_ADMIN_GROUP is not a group email address, so the administrator group is off.";

      warnOnce(problem);

      return { group, problem, source: "env" };
    }

    return { group, source: "env" };
  }

  const fromSettings = stored?.["google.adminGroup"];

  if (fromSettings?.trim()) {
    return { group: normalizeGroupAddress(fromSettings), source: "settings" };
  }

  return { group: null, source: "none" };
}

export type AdminGroupSyncResult =
  | { status: "not_configured" }
  | { status: "lookup_failed" }
  | { isMember: boolean; result: DirectoryRoleResult; status: "synced" };

type SyncOptions = {
  /** Replaced in tests. Null means the directory is not set up. */
  directory?: DirectoryClient | null;
  env?: EnvSource;
  /** Replaced in tests. */
  group?: string | null;
};

/**
 * Brings one account's role in line with the administrator group. Never
 * throws: a sign-in is not refused because this could not be done.
 */
export async function syncAdminRoleFromGroup(
  user: { email: string; id: string },
  options: SyncOptions = {},
): Promise<AdminGroupSyncResult> {
  const env = options.env ?? process.env;

  try {
    let { directory, group } = options;

    if (directory === undefined || group === undefined) {
      const stored = await getIntegrationSettings(env);

      directory ??= getDirectoryClient(env, stored);
      group ??= readAdminGroup(env, stored).group;
    }

    if (!directory || !group) {
      return { status: "not_configured" };
    }

    let isMember: boolean;

    try {
      isMember = await directory.isGroupMember(group, user.email);
    } catch (error) {
      logSecurityEvent("warn", {
        category: "admin_group_lookup_failed",
        message:
          "Could not check the administrator group at sign-in; the role was left as it is.",
        metadata: {
          error: error instanceof Error ? error.message : "unknown",
        },
        userId: user.id,
      });

      return { status: "lookup_failed" };
    }

    const result = await setPersonRoleFromDirectory(
      user.id,
      isMember ? "admin" : "user",
      { group, provider: "google_group" },
    );

    if (!result.changed && result.reason === "last_admin") {
      logSecurityEvent("warn", {
        category: "admin_group_last_admin",
        message:
          "The last administrator is not in the administrator group; they keep the role so the site is never left without one.",
        userId: user.id,
      });
    }

    return { isMember, result, status: "synced" };
  } catch (error) {
    logSecurityEvent("error", {
      category: "admin_group_sync_failure",
      message: "Could not bring the role in line with the administrator group.",
      metadata: { error: error instanceof Error ? error.message : "unknown" },
      userId: user.id,
    });

    return { status: "lookup_failed" };
  }
}
