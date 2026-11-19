import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  readLastOffboardingRun,
  runOffboarding,
} from "@/lib/workspace/offboarding";

// Offboarding in Settings, for administrators: GET shows the last run, POST
// runs it now, as the scheduled job would (src/lib/workspace/offboarding.ts).

export const maxDuration = 300;

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "directory_sync_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Offboarding from Settings failed.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ lastRun: await readLastOffboardingRun() });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

/** What the page says when a run could not go ahead. */
const NOT_RUN: Record<string, string> = {
  already_running: "A run is already going. Try again in a minute.",
  no_directory:
    "There is no directory to ask. Choose a provider, turn the directory on and save.",
  no_domains:
    "No organization domains are set, so nobody would be asked about. Enter them and save.",
  off: "Offboarding is off. Turn it on and save first.",
};

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "workspace_offboarding",
    key: buildRateLimitKey(["workspace-offboarding", session.user.id]),
    limit: 5,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const outcome = await runOffboarding();

    if (outcome.status !== "ran") {
      const reason =
        outcome.status === "not_configured" ? outcome.reason : outcome.status;

      return NextResponse.json({ error: NOT_RUN[reason] }, { status: 409 });
    }

    return NextResponse.json({ lastRun: await readLastOffboardingRun() });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
