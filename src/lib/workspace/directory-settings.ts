import { normalizeEmailDomain } from "../signup-policy.ts";
import type { EnvSource } from "../utils/env.ts";
import {
  resolveWorkspaceSetting,
  type ResolvedWorkspaceSetting,
  type WorkspaceSettings,
} from "./settings.ts";

// The directory's two settings, read the same way by every provider and by
// the pages: whether it is on, and which group's members are
// administrators.

/**
 * Whether the directory is on. It is off until an administrator turns it
 * on (Settings, or WORKSPACE_DIRECTORY=on), so an install that can reach a
 * directory does not start asking it unasked.
 */
export function isDirectoryEnabled(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): boolean {
  return (
    resolveWorkspaceSetting("directory.enabled", stored, env)
      .value?.trim()
      .toLowerCase() === "on"
  );
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

export type AdminGroupSetting = {
  group: string | null;
  /** Why a value that is set cannot be used, when it cannot. */
  problem?: string;
  source: ResolvedWorkspaceSetting["source"];
};

const warned = new Set<string>();

/** The administrator group, or null when none is set or it is not usable. */
export function readAdminGroup(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): AdminGroupSetting {
  const setting = resolveWorkspaceSetting("directory.adminGroup", stored, env);

  if (!setting.value) {
    return { group: null, source: "none" };
  }

  const group = normalizeGroupAddress(setting.value);

  if (!group) {
    const problem =
      setting.source === "env"
        ? "WORKSPACE_ADMIN_GROUP is not a group email address, so the administrator group is off."
        : "The administrator group is not a group email address, so it is off.";

    if (!warned.has(problem)) {
      warned.add(problem);
      console.warn(`[workspace] ${problem}`);
    }

    return { group: null, problem, source: setting.source };
  }

  return { group, source: setting.source };
}
