import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";
import { isMissingSchemaError } from "./settings.ts";

// Whether the organization's Google Workspace directory has blocked an
// account's sign-in (directory-sync.ts sets and clears the block). Asked by
// both ways in, a password and single sign-on (auth/server.ts), so someone
// who has left the organization cannot use a password they set before
// password sign-in was turned off either.
//
// The message names the reason plainly. It does tell whoever types the
// address that the account exists and was blocked, which a wrong password
// does not; that is the same as the lockout message after too many wrong
// passwords, and the person who left is the one who most needs to know why.

export const DIRECTORY_BLOCKED_CODE = "DIRECTORY_BLOCKED";

export const DIRECTORY_BLOCKED_MESSAGE =
  "This account was suspended or removed in your organization's Google Workspace, so it can no longer sign in here. Ask an administrator if this is a mistake.";

/**
 * True when the account with this address may not sign in because of the
 * directory. An address with no account is not blocked. A database from
 * before the block existed blocks nobody.
 */
export async function isSignInBlockedByDirectory(
  email: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  const address = email.trim().toLowerCase();

  if (!address) {
    return false;
  }

  try {
    const row = await queryOne<{ blocked: boolean }>(
      database,
      `
        SELECT true AS blocked
        FROM "user"
        WHERE lower(email) = $1 AND directory_blocked_at IS NOT NULL
        LIMIT 1
      `,
      [address],
    );

    return row !== null;
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false;
    }

    throw error;
  }
}
