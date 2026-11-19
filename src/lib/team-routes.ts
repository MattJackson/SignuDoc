import { NextResponse } from "next/server";

import { requireAdminSession } from "./auth/admin.ts";
import { logRouteError } from "./security/logging.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "./security/route-controls.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "./security/request.ts";
import { listTeams, TeamError, type TeamActor } from "./teams.ts";

// What the routes under /api/admin/teams share: an administrator's session,
// a rate limit on changes, and the answer, which is always the list of
// teams as it now stands.

const noStore = { "cache-control": "private, no-store" };

export async function respondWithTeams(status = 200) {
  return NextResponse.json(
    { teams: await listTeams() },
    { headers: noStore, status },
  );
}

/**
 * Runs one change to the teams for an administrator, and answers with the
 * list after it. `change` gets who is making it, for the audit trail.
 */
export async function handleTeamChange(
  request: Request,
  category: string,
  change: (actor: TeamActor) => Promise<unknown>,
) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const rateLimitResponse = await applyRateLimit({
    category: "team_change",
    key: buildRateLimitKey(["team-change", sessionResult.user.id]),
    limit: 120,
    request,
    userId: sessionResult.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    await change({
      email: sessionResult.user.email,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
      userId: sessionResult.user.id,
    });

    return await respondWithTeams();
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category,
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while changing a team.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "That change could not be saved." },
      { headers: noStore, status: 500 },
    );
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
