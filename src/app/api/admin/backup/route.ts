import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import type { BackupTarget } from "@/lib/backup";
import {
  BackupConfigError,
  getBackupConfig,
  getBackupSettingsView,
  parseBackupConfigInput,
  readStoredBackupConfig,
  runConfiguredBackup,
  saveBackupConfig,
  targetFromInput,
  testBackupTarget,
} from "@/lib/backup-config";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

// The Backups section of Settings: where the daily backup goes, a test of
// that destination, and "Run backup now". Administrators only.

export const maxDuration = 300;

const noStore = { "cache-control": "private, no-store" };
/** Leaves time to answer before the function is stopped. */
const COPY_BUDGET_MS = 240_000;

async function authorize(request: Request, limit: number) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const rateLimitResponse = await applyRateLimit({
    category: "backup_settings",
    key: buildRateLimitKey(["backup-settings", sessionResult.user.id]),
    limit,
    request,
    userId: sessionResult.user.id,
    windowMs: 10 * 60 * 1000,
  });

  return rateLimitResponse ?? sessionResult;
}

function failure(request: Request, userId: string, error: unknown) {
  if (error instanceof BackupConfigError) {
    return NextResponse.json(
      { error: error.message },
      { headers: noStore, status: error.statusCode },
    );
  }

  logRouteError(error, {
    category: "backup_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the backup settings.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { headers: noStore, status: 500 },
  );
}

export async function GET(request: Request) {
  const session = await authorize(request, 120);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json(await getBackupSettingsView(), {
      headers: noStore,
    });
  } catch (error) {
    return failure(request, session.user.id, error);
  }
}

/** Saves where backups go, how long copies are kept, and the daily run. */
export async function PUT(request: Request) {
  const session = await authorize(request, 30);

  if (session instanceof Response) {
    return session;
  }

  try {
    const input = parseBackupConfigInput(
      await request.json().catch(() => null),
    );

    await saveBackupConfig(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      input,
    );

    return NextResponse.json(await getBackupSettingsView(), {
      headers: noStore,
    });
  } catch (error) {
    return failure(request, session.user.id, error);
  }
}

/**
 * { action: "test", destination } tries a destination (the saved one
 * when none is given) without saving it. { action: "run" } runs a backup
 * now, to the saved destination.
 */
export async function POST(request: Request) {
  const session = await authorize(request, 20);

  if (session instanceof Response) {
    return session;
  }

  const startedAt = Date.now();

  try {
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      destination?: unknown;
    } | null;

    if (body?.action === "test") {
      let target: BackupTarget | null;

      if (body.destination) {
        const input = parseBackupConfigInput({
          destination: body.destination,
          keepDays: 30,
        });

        target = targetFromInput(
          input.destination,
          await readStoredBackupConfig(),
        );
      } else {
        target = (await getBackupConfig()).target;
      }

      if (!target) {
        throw new BackupConfigError("Choose where backups go first.");
      }

      return NextResponse.json(await testBackupTarget(target), {
        headers: noStore,
      });
    }

    if (body?.action === "run") {
      await recordSystemAuditEvent({
        actorEmail: session.user.email,
        actorUserId: session.user.id,
        event: "backup_run_requested",
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      });

      const outcome = await runConfiguredBackup({
        deadline: startedAt + COPY_BUDGET_MS,
        trigger: "manual",
      });

      return NextResponse.json(
        { outcome, view: await getBackupSettingsView() },
        { headers: noStore },
      );
    }

    throw new BackupConfigError("Unknown action.");
  } catch (error) {
    return failure(request, session.user.id, error);
  }
}
