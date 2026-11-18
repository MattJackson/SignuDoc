import { type DbExecutor, getDb, queryOne } from "../../../db/connection.ts";
import { getEmailDomain } from "../../../signup-policy.ts";
import type { AddonCaller } from "./verify-request.ts";

// From the person Google says is using the add-on to their SignuDoc
// account. Only by the verified email address in the user ID token, and
// only when that address is at one of the Workspace domains (when any are
// known): an account that merely has the same address at another domain is
// never matched. Someone with no account yet is asked to sign in to the
// site once, which makes it under the sign-up rule as usual; the add-on
// never creates accounts.
//
// Google is the second step here, as for a Google sign-in: its MFA and
// login challenges apply before Google issues the token, so the site's own
// two-step sign-in is not asked for.

export type AddonUser = {
  email: string;
  id: string;
  name: string;
};

export type AddonUserLookup =
  | { kind: "found"; user: AddonUser }
  | { kind: "no_account" }
  | { kind: "unverified" }
  | { kind: "outside_workspace" };

/** Whether the address belongs to one of the domains (any, when none). */
export function isEmailInWorkspace(
  email: string,
  domains: readonly string[],
): boolean {
  const domain = getEmailDomain(email);

  if (!domain) {
    return false;
  }

  return domains.length === 0 || domains.includes(domain);
}

export async function findAddonUser(
  caller: Pick<AddonCaller, "email">,
  workspaceDomains: readonly string[],
  database: DbExecutor = getDb(),
): Promise<AddonUserLookup> {
  const email = caller.email.trim().toLowerCase();

  if (!isEmailInWorkspace(email, workspaceDomains)) {
    return { kind: "outside_workspace" };
  }

  const row = await queryOne<{
    email: string;
    emailVerified: boolean;
    id: string;
    name: string;
  }>(
    database,
    `
      SELECT id, name, email, "emailVerified"
      FROM public."user"
      WHERE lower(email) = $1
      LIMIT 1
    `,
    [email],
  );

  if (!row) {
    return { kind: "no_account" };
  }

  if (!row.emailVerified) {
    return { kind: "unverified" };
  }

  return {
    kind: "found",
    user: { email: row.email, id: row.id, name: row.name || row.email },
  };
}
