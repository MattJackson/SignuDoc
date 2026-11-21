import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { type EnvelopeScope, parseEnvelopeScope } from "@/lib/envelope-access";
import {
  listEnvelopesForUser,
  type DashboardEnvelopePage,
} from "@/lib/envelopes";
import { listTeamsForUser } from "@/lib/teams";

/** Envelopes on one page of the dashboard. */
const DASHBOARD_PAGE_SIZE = 48;

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function buildDashboardHref({
  page,
  search,
  view,
}: {
  page: number;
  search: string;
  view: EnvelopeScope;
}): string {
  const params = new URLSearchParams();

  if (view !== "mine") {
    params.set("view", view);
  }

  if (search) {
    params.set("q", search);
  }

  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/dashboard?${query}` : "/dashboard";
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const session = await getAuthSession();
  const database = getDb();
  const params = await searchParams;
  // "scope" is what earlier links called it.
  const requestedView = parseEnvelopeScope(
    firstValue(params.view) || firstValue(params.scope),
  );
  const search = firstValue(params.q).trim().slice(0, 160);
  const requestedPage = Number.parseInt(firstValue(params.page), 10);
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 1
      ? requestedPage
      : 1;
  let result: DashboardEnvelopePage | undefined;
  let initialState: "default" | "empty" | "error" = "error";
  // Whose envelopes can be shown: one's own, a team's when one is on a
  // team, and every sent one for an administrator.
  let views: EnvelopeScope[] = ["mine"];
  let view: EnvelopeScope = "mine";

  try {
    if (session) {
      const [isAdmin, teams] = await Promise.all([
        isAdminUser(session.user.id, database),
        listTeamsForUser(session.user.id, database),
      ]);

      views = [
        "mine",
        ...(teams.length > 0 ? (["team"] as const) : []),
        ...(isAdmin ? (["all"] as const) : []),
      ];
      view = views.includes(requestedView) ? requestedView : "mine";
    }

    const filters = {
      limit: DASHBOARD_PAGE_SIZE,
      page,
      scope: view,
      ...(search ? { search } : {}),
    };

    result = !session
      ? { envelopes: [], hasMore: false }
      : await listEnvelopesForUser(session.user.id, filters, database);
    // Nothing at all yet, as opposed to nothing that matches or nothing
    // on this page. A team's list is never "empty": one's own may not be.
    initialState =
      result.envelopes.length === 0 && !search && page === 1 && view !== "team"
        ? "empty"
        : "default";
  } catch {
    initialState = "error";
  }

  return (
    <DashboardShell
      // A new search or view starts the shell afresh, with its own search box.
      key={`${view}:${search}`}
      envelopes={result?.envelopes}
      initialSearch={search}
      initialState={initialState}
      pagination={{
        newerHref:
          page > 1
            ? buildDashboardHref({ page: page - 1, search, view })
            : undefined,
        olderHref: result?.hasMore
          ? buildDashboardHref({ page: page + 1, search, view })
          : undefined,
      }}
      view={view}
      views={views}
    />
  );
}
