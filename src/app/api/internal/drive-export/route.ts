import { NextResponse } from "next/server";

import { runDueDriveExports } from "@/lib/integrations/google/drive-export";
import { identifyRetentionCaller } from "@/lib/retention-job";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Tries again the executed-copy exports to the Shared Drive that are due
// (src/lib/integrations/google/drive-export.ts): every completion is tried
// once right away, and this picks up whatever failed. Meant to be called
// every 15 minutes, by Cloud Scheduler or any other scheduler, with GET or
// POST. It does nothing while no export is waiting.
//
// Callers are trusted the same way as the daily cleanup's: with CRON_SECRET
// or RETENTION_JOB_SECRET set, only a caller with it ("Authorization:
// Bearer <secret>") gets in. Without one, anyone may call, at most once in
// 10 minutes whoever asks, and gets an empty answer.

export const maxDuration = 300;

const ANONYMOUS_RUN_INTERVAL_MS = 10 * 60 * 1000;
/** Leaves time to write the outcome before the function is stopped. */
const RUN_BUDGET_MS = 240_000;

async function handle(request: Request) {
  const startedAt = Date.now();
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (caller === "anonymous") {
    const ration = await consumeRateLimit({
      key: "job:drive-export",
      limit: 1,
      windowMs: ANONYMOUS_RUN_INTERVAL_MS,
    });

    if (!ration.allowed) {
      return new NextResponse(null, { status: 204 });
    }
  }

  try {
    const summary = await runDueDriveExports({
      deadline: startedAt + RUN_BUDGET_MS,
    });

    if (summary.tried > 0) {
      logSecurityEvent(summary.failed > 0 ? "error" : "info", {
        category: "drive_export_run",
        message:
          summary.failed > 0
            ? `Drive export: ${String(summary.failed)} gave up after every try.`
            : "Drive export run finished.",
        metadata: summary,
      });
    }

    return caller === "authorized"
      ? NextResponse.json(summary)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError(error, {
      category: "drive_export_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The Drive export run failed.",
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
