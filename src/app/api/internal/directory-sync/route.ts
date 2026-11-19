import { NextResponse } from "next/server";

import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  isOffboardingEnabled,
  offboardingHttpStatus,
  runOffboarding,
} from "@/lib/workspace/offboarding";
import { getWorkspaceContext } from "@/lib/workspace/registry";

// Offboarding from the organization's directory
// (src/lib/workspace/offboarding.ts). Vercel's cron job calls this with GET
// (see vercel.json); a scheduler elsewhere can use POST.
//
// Callers prove themselves with the same secrets as the daily cleanup
// (CRON_SECRET or RETENTION_JOB_SECRET). Unlike the cleanup, this never
// runs for an anonymous caller: it decides who can sign in. With no secret
// configured it answers an empty 204 and does nothing, so an install that
// does not use offboarding sees no failed cron.

export const maxDuration = 300;

async function handle(request: Request) {
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (caller === "anonymous") {
    const { settings } = await getWorkspaceContext();

    if (isOffboardingEnabled(settings)) {
      console.warn(
        "[offboarding] Offboarding is on but cannot run: set CRON_SECRET (or RETENTION_JOB_SECRET) and send it as Authorization: Bearer <secret>.",
      );
    }

    return new NextResponse(null, { status: 204 });
  }

  try {
    const outcome = await runOffboarding();
    const status = offboardingHttpStatus(outcome);

    if (outcome.status === "ran") {
      logSecurityEvent(outcome.stoppedEarly ? "error" : "info", {
        category: "directory_sync_finished",
        message: outcome.stoppedEarly
          ? "Offboarding stopped: most directory lookups failed, so nothing was changed."
          : "Offboarding finished.",
        metadata: outcome.counts,
        path: getRequestPathname(request),
      });
    } else if (status !== 200) {
      logSecurityEvent("error", {
        category: "directory_sync_not_runnable",
        message:
          "Offboarding is turned on but cannot run: it has no usable directory or no organization domains.",
        metadata: { status: outcome.status },
        path: getRequestPathname(request),
      });
    }

    // A run the directory could not answer shows as failed in the
    // scheduler, which is where someone will look.
    return NextResponse.json(outcome, { status });
  } catch (error) {
    logRouteError(error, {
      category: "directory_sync_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Offboarding failed.",
      path: getRequestPathname(request),
    });

    return new NextResponse(null, { status: 500 });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
