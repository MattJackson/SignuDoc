import {
  setPersonRoleFromDirectory,
  type DirectoryRoleResult,
} from "../people.ts";
import { logSecurityEvent } from "../security/logging.ts";
import type { EnvSource } from "../utils/env.ts";
import { readAdminGroup } from "./directory-settings.ts";
import { getWorkspaceContext, resolveCapabilityProvider } from "./registry.ts";
import type { WorkspaceDirectory } from "./types.ts";

// A group in the organization's directory whose members are this install's
// administrators. When it is set (WORKSPACE_ADMIN_GROUP, or Settings) and
// the directory is on, each single sign-on sign-in brings the account's role
// in line with the group: a member becomes an administrator, and an
// administrator who has left the group stops being one.
//
// - Membership counts through nested groups too.
// - The last administrator is never removed (people.ts), so a group emptied
//   by mistake cannot leave the install with none.
// - If the directory cannot be asked, nothing changes: a failed lookup is
//   not taken as "not a member".
// - Only a confirmed address is made an administrator (people.ts).
// - Password sign-ins are not synced, so the break-glass administrator kept
//   for when the identity provider is down keeps the role.
// - Every change is in the site audit trail as a role change, naming the
//   group.

export type AdminGroupSyncResult =
  | { status: "not_configured" }
  | { status: "lookup_failed" }
  | { isMember: boolean; result: DirectoryRoleResult; status: "synced" };

type SyncOptions = {
  /** Replaced in tests. Null means the directory is not set up. */
  directory?: WorkspaceDirectory | null;
  env?: EnvSource;
  /** Replaced in tests. */
  group?: string | null;
  /** The provider's id, for the audit trail. */
  provider?: string;
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
    const context =
      options.group === undefined || options.directory === undefined
        ? await getWorkspaceContext(env)
        : null;
    const group =
      options.group === undefined
        ? readAdminGroup(context?.settings ?? null, env).group
        : options.group;

    if (!group) {
      return { status: "not_configured" };
    }

    let directory = options.directory;
    let provider = options.provider ?? "directory";

    if (directory === undefined && context) {
      const chosen = resolveCapabilityProvider(
        "directory",
        context.settings,
        env,
      ).provider;

      directory = chosen?.directory?.(context) ?? null;
      provider = chosen ? `${chosen.id}_group` : provider;
    }

    if (!directory) {
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
      { group, provider },
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
