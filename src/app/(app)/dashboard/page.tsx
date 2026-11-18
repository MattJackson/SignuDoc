import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { type EnvelopeScope, parseEnvelopeScope } from "@/lib/envelope-access";
import { listEnvelopesForUser } from "@/lib/envelopes";
import { listTeamsForUser } from "@/lib/teams";

type DashboardPageProps = {
  searchParams?: Promise<{ scope?: string | string[] }>;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const session = await getAuthSession();
  const database = getDb();
  const requestedScope = parseEnvelopeScope((await searchParams)?.scope);
  let envelopes: Awaited<ReturnType<typeof listEnvelopesForUser>> | undefined;
  let initialState: "default" | "empty" | "error" = "error";
  // Whose envelopes can be shown: one's own, a team's when one is on a
  // team, and every sent one for an administrator.
  let scopes: EnvelopeScope[] = ["mine"];
  let scope: EnvelopeScope = "mine";

  try {
    if (session) {
      const [isAdmin, teams] = await Promise.all([
        isAdminUser(session.user.id, database),
        listTeamsForUser(session.user.id, database),
      ]);

      scopes = [
        "mine",
        ...(teams.length > 0 ? (["team"] as const) : []),
        ...(isAdmin ? (["all"] as const) : []),
      ];
      scope = scopes.includes(requestedScope) ? requestedScope : "mine";
    }

    envelopes = session
      ? await listEnvelopesForUser(session.user.id, { scope }, database)
      : [];
    initialState =
      envelopes.length === 0 && scope === "mine" ? "empty" : "default";
  } catch {
    initialState = "error";
  }

  return (
    <DashboardShell
      envelopes={envelopes}
      initialState={initialState}
      scope={scope}
      scopes={scopes}
    />
  );
}
