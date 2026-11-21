import { NextResponse } from "next/server";

import {
  directorySyncHttpStatus,
  parseDirectorySyncRequest,
  runDirectorySync,
} from "@/lib/directory-sync";
import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Offboarding from the Google Workspace directory (src/lib/directory-sync.ts),
// called by a scheduler such as Google Cloud Scheduler, with GET or POST.
// ?dryRun=1 (or a JSON body { "dryRun": true }) reports what would be done
// and changes nothing; ?limit= lowers the per-run cap.
//
// Callers prove themselves with the same secrets as the daily cleanup
// (CRON_SECRET or RETENTION_JOB_SECRET). Unlike the cleanup, this route is
// never open: it decides who can sign in, so with no secret configured it
// refuses everyone rather than run for anyone who finds the URL.

export const maxDuration = 300;

async function readBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (request.method !== "POST") {
    return { ok: true, value: undefined };
  }

  const text = await request.text();

  if (!text.trim()) {
    return { ok: true, value: undefined };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function handle(request: Request) {
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "anonymous") {
    return NextResponse.json(
      {
        error:
          "No job secret is configured, so the directory sync cannot run. Set RETENTION_JOB_SECRET (or CRON_SECRET) and send it as Authorization: Bearer <secret>.",
      },
      { status: 503 },
    );
  }

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await readBody(request);
  const parsed = body.ok
    ? parseDirectorySyncRequest(new URL(request.url).searchParams, body.value)
    : ({ message: "The body is not valid JSON.", ok: false } as const);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  try {
    const outcome = await runDirectorySync(parsed.request);

    if (outcome.status !== "ran") {
      const status = directorySyncHttpStatus(outcome);

      if (status !== 200) {
        logSecurityEvent("error", {
          category: "directory_sync_not_runnable",
          message:
            "The directory sync is turned on but cannot run: it has no usable directory or no Workspace domains.",
          metadata: { status: outcome.status },
          path: getRequestPathname(request),
        });
      }

      return NextResponse.json(outcome, { status });
    }

    logSecurityEvent(outcome.stoppedEarly ? "error" : "info", {
      category: "directory_sync_finished",
      message: outcome.stoppedEarly
        ? "The directory sync stopped: most directory lookups failed, so nothing was changed."
        : `The directory sync ${outcome.dryRun ? "dry run " : ""}finished.`,
      metadata: { ...outcome.counts, dryRun: outcome.dryRun },
      path: getRequestPathname(request),
    });

    // A run the directory could not answer shows as failed in the
    // scheduler, which is where someone will look.
    return NextResponse.json(outcome, {
      status: directorySyncHttpStatus(outcome),
    });
  } catch (error) {
    logRouteError(error, {
      category: "directory_sync_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The directory sync failed.",
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
