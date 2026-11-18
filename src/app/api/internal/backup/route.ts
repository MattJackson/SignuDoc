import { NextResponse } from "next/server";

import { runConfiguredBackup } from "@/lib/backup-config";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The daily backup (src/lib/backup.ts) to wherever Settings, Backups or the
// environment send it: a second Vercel Blob store or a Google Cloud Storage
// bucket, whatever the install keeps its own files in. On Vercel the cron
// job in vercel.json calls it; elsewhere a scheduler of the deployer's own
// (Cloud Scheduler, say). It does nothing until a destination is chosen.
//
// Callers are trusted the same way as the daily cleanup's: with CRON_SECRET
// or RETENTION_JOB_SECRET set, only a caller with it gets in. Without one,
// anyone may call, and a run happens at most once in 20 hours whoever asks,
// which is the most an outside caller can make it cost.

export const maxDuration = 300;

const ANONYMOUS_RUN_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Leaves time to write the summary before the function is stopped. */
const COPY_BUDGET_MS = 240_000;

async function handle(request: Request) {
  const startedAt = Date.now();
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const outcome = await runConfiguredBackup({
      deadline: startedAt + COPY_BUDGET_MS,
      trigger: "schedule",
      // An anonymous caller spends the one slot only when a run is about to
      // start, not on a call that finds nothing to do.
      claimSlot:
        caller === "anonymous"
          ? async () =>
              (
                await consumeRateLimit({
                  key: "job:backup",
                  limit: 1,
                  windowMs: ANONYMOUS_RUN_INTERVAL_MS,
                })
              ).allowed
          : undefined,
    });

    switch (outcome.status) {
      case "not_configured":
      case "disabled":
      case "busy":
        return caller === "authorized"
          ? NextResponse.json({ status: outcome.status })
          : new NextResponse(null, { status: 204 });
      case "misconfigured":
        logSecurityEvent("error", {
          category: "backup_misconfigured",
          message: outcome.message,
          path: getRequestPathname(request),
        });

        return NextResponse.json({ error: outcome.message }, { status: 500 });
      case "failed":
        logSecurityEvent("error", {
          category: "backup_failure",
          message: `The backup failed: ${outcome.message}`,
          path: getRequestPathname(request),
        });

        return new NextResponse(null, { status: 500 });
      case "finished": {
        const { summary } = outcome;
        const failed = summary.fileFailures.length > 0;

        logSecurityEvent(failed ? "error" : "info", {
          category: "backup_finished",
          message: failed
            ? `The backup finished, but ${String(summary.fileFailures.length)} files could not be copied.`
            : "The backup finished.",
          metadata: {
            ...summary,
            fileFailures: summary.fileFailures.slice(0, 20),
          },
        });

        if (caller === "authorized") {
          return NextResponse.json(summary, { status: failed ? 500 : 200 });
        }

        return new NextResponse(null, { status: failed ? 500 : 204 });
      }
    }
  } catch (error) {
    logRouteError(error, {
      category: "backup_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The backup failed.",
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
