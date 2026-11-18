import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";
import {
  getIntegrationSettings,
  readIntegrationSettings,
  type IntegrationSettings,
} from "./integration-settings.ts";
import { GoogleCredentialsError } from "./integrations/google/credentials.ts";
import {
  DirectoryError,
  getDirectoryClient,
  type DirectoryClient,
} from "./integrations/google/directory.ts";
import { firstStepSigners } from "./signing-steps.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// The sender's manager, from the organization's Google Workspace directory
// (the "manager" relation on the sender's own entry), and the
// administrator's rule for it:
//
// - off: nothing is said. The sender can still add their manager with one
//   click when the directory is on.
// - suggest: the signers page suggests adding the manager as an approver in
//   the first step, and the review page says so if they are not there.
// - require: an envelope is not sent unless the sender's manager is an
//   approver in the first step of its signing order, so nothing reaches a
//   customer before the manager has approved it.
//
// The rule can be limited to the members of chosen teams. It does not apply
// in Part 11 mode, where approvers are not offered (envelopes.ts); the
// settings page says so.
//
// When the manager cannot be found (no manager in the directory, the
// manager's account suspended, or the directory not answering), the sender
// is told which, and in require mode the envelope stays a draft until it is
// fixed. A failed lookup is never taken as "no manager needed".

export const managerPolicyModes = ["off", "suggest", "require"] as const;
export type ManagerPolicyMode = (typeof managerPolicyModes)[number];

export type ManagerPolicy = {
  mode: ManagerPolicyMode;
  /** Where the mode comes from. */
  source: "default" | "env" | "settings";
  /** Team ids the rule is limited to. Empty means everyone. */
  teamIds: string[];
};

export function parseManagerPolicyMode(
  value: string | null | undefined,
): ManagerPolicyMode | null {
  const normalized = value?.trim().toLowerCase();

  return (managerPolicyModes as readonly string[]).includes(normalized ?? "")
    ? (normalized as ManagerPolicyMode)
    : null;
}

/** Ids separated by commas, without blanks or repeats. */
export function parseTeamIdList(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 200),
    ),
  ];
}

/** MANAGER_APPROVAL wins over the stored setting; off when neither is set. */
export function readManagerPolicy(
  env: EnvSource = process.env,
  stored: Pick<
    IntegrationSettings,
    "people.managerPolicy" | "people.managerPolicyTeams"
  > | null = null,
): ManagerPolicy {
  const teamIds = parseTeamIdList(stored?.["people.managerPolicyTeams"]);
  const fromEnv = parseManagerPolicyMode(readEnv(env, "MANAGER_APPROVAL"));

  if (fromEnv) {
    return { mode: fromEnv, source: "env", teamIds };
  }

  const fromSettings = parseManagerPolicyMode(stored?.["people.managerPolicy"]);

  if (fromSettings) {
    return { mode: fromSettings, source: "settings", teamIds };
  }

  return { mode: "off", source: "default", teamIds };
}

/**
 * The rule in force. With a database, its settings are read from that
 * database (the one the caller is working in); without one, from the
 * short-lived cache of this site's own.
 */
export async function loadManagerPolicy(
  env: EnvSource = process.env,
  database?: DbExecutor,
): Promise<ManagerPolicy> {
  return readManagerPolicy(
    env,
    database
      ? await readIntegrationSettings(database, env)
      : await getIntegrationSettings(env),
  );
}

/** Whether the rule covers this sender: everyone, or a chosen team's member. */
export async function managerPolicyAppliesTo(
  userId: string,
  policy: ManagerPolicy,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  if (policy.mode === "off") {
    return false;
  }

  if (policy.teamIds.length === 0) {
    return true;
  }

  const member = await queryOne<{ found: boolean }>(
    database,
    `
      SELECT true AS found
      FROM team_members
      WHERE user_id = $1 AND team_id = ANY($2::text[])
      LIMIT 1
    `,
    [userId, policy.teamIds],
  );

  return Boolean(member);
}

export type SenderManager =
  | { manager: { email: string; name: string }; status: "found" }
  /** The directory is off, or there are no Google credentials. */
  | { status: "directory_off" }
  /** The sender is not in the directory, so it names no manager. */
  | { status: "not_in_directory" }
  | { status: "no_manager" }
  /** The directory names a manager whose account is suspended or gone. */
  | { email: string; status: "manager_inactive" }
  /** The directory could not be asked just now. */
  | { status: "lookup_failed" };

/** The sender's manager as the directory has it. */
export async function findSenderManager(
  senderEmail: string,
  {
    directory,
  }: {
    /** Replaced in tests. Null means the directory is off. */
    directory?: DirectoryClient | null;
  } = {},
): Promise<SenderManager> {
  let client: DirectoryClient | null;

  try {
    client =
      directory === undefined
        ? getDirectoryClient(process.env, await getIntegrationSettings())
        : directory;
  } catch {
    client = null;
  }

  if (!client) {
    return { status: "directory_off" };
  }

  try {
    const sender = await client.getUser(senderEmail);

    if (!sender) {
      return { status: "not_in_directory" };
    }

    if (!sender.managerEmail) {
      return { status: "no_manager" };
    }

    const manager = await client.getUser(sender.managerEmail);

    if (!manager || manager.suspended || manager.archived) {
      return { email: sender.managerEmail, status: "manager_inactive" };
    }

    return {
      manager: {
        email: manager.email,
        // The name the directory has, or the address when it has none.
        name: manager.name.trim() || manager.email,
      },
      status: "found",
    };
  } catch (error) {
    if (
      error instanceof DirectoryError ||
      error instanceof GoogleCredentialsError
    ) {
      return { status: "lookup_failed" };
    }

    throw error;
  }
}

/** What to tell the sender when their manager cannot be added. */
export function describeSenderManagerProblem(
  result: Exclude<SenderManager, { status: "found" }>,
): string {
  switch (result.status) {
    case "directory_off":
      return "The Google Workspace directory is not turned on, so your manager cannot be looked up. Ask an administrator.";
    case "not_in_directory":
      return "Your account is not in the Google Workspace directory, so it names no manager for you.";
    case "no_manager":
      return "The Google Workspace directory names no manager for you. Ask your Workspace administrator to set your manager.";
    case "manager_inactive":
      return `The directory names ${result.email} as your manager, but that account is suspended or no longer exists. Ask your Workspace administrator to update your manager.`;
    case "lookup_failed":
      return "Google's directory did not answer, so your manager could not be looked up. Try again in a minute.";
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

type SigningOrderEntry = {
  email: string;
  role?: string | null;
  signOrder?: number;
  signingStep?: number | null;
};

/** The manager is an approver in the first step of the signing order. */
export function hasManagerApprovalFirst(
  signers: readonly SigningOrderEntry[],
  managerEmail: string,
): boolean {
  const manager = managerEmail.trim().toLowerCase();

  return firstStepSigners(signers).some(
    (signer) =>
      signer.role === "approver" && signer.email.toLowerCase() === manager,
  );
}

export type ManagerPolicyCheck =
  | { status: "not_applicable" }
  | { status: "satisfied" }
  /** Suggest mode: worth saying, does not stop the send. */
  | {
      manager: { email: string; name: string } | null;
      message: string;
      status: "suggested";
    }
  /** Require mode: the send is refused with this message. */
  | { message: string; status: "blocked" };

/**
 * Checks a draft's signing order against the rule for its sender. Used by
 * the review page and, again, by the send itself.
 */
export async function checkManagerPolicy(
  sender: { email: string; id: string },
  signers: readonly SigningOrderEntry[],
  {
    database,
    directory,
    part11 = false,
    policy,
  }: {
    database?: DbExecutor;
    directory?: DirectoryClient | null;
    part11?: boolean;
    policy?: ManagerPolicy;
  } = {},
): Promise<ManagerPolicyCheck> {
  const current = policy ?? (await loadManagerPolicy(process.env, database));

  if (
    current.mode === "off" ||
    part11 ||
    !(await managerPolicyAppliesTo(sender.id, current, database ?? getDb()))
  ) {
    return { status: "not_applicable" };
  }

  const found = await findSenderManager(sender.email, { directory });

  if (found.status !== "found") {
    const problem = describeSenderManagerProblem(found);

    return current.mode === "require"
      ? {
          message: `This site requires your manager to approve first. ${problem}`,
          status: "blocked",
        }
      : { manager: null, message: problem, status: "suggested" };
  }

  if (hasManagerApprovalFirst(signers, found.manager.email)) {
    return { status: "satisfied" };
  }

  const message = `Add your manager, ${found.manager.name}, as an approver in the first step of the signing order${
    current.mode === "require"
      ? ". This site requires their approval before anyone else is asked."
      : ", so they approve it before anyone else is asked."
  }`;

  return current.mode === "require"
    ? { message, status: "blocked" }
    : { manager: found.manager, message, status: "suggested" };
}
