import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
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
import {
  checkWorkspaceFiles,
  getFilesProviderChoice,
  getWorkspaceFilesSettingsView,
  saveWorkspaceFilesSettings,
  WorkspaceFilesSettingsError,
} from "@/lib/workspace/export-settings";
import {
  listWorkspaceExports,
  retryWorkspaceExport,
} from "@/lib/workspace/exports";
import { WorkspaceSettingsError } from "@/lib/workspace/settings";

// Settings, "Shared folder for completed envelopes": where executed copies
// go, the provider's options for files, the checks an administrator can
// run, and the copies with a way to try one again. Administrators only.
// Every saved change is in the install's audit trail.

export const maxDuration = 60;

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }),
  z.object({
    action: z.literal("list_exports"),
    status: z.enum(["exported", "failed", "pending"]).optional(),
  }),
  z.object({
    action: z.literal("retry_export"),
    envelopeId: z.string().trim().min(1).max(100),
  }),
]);

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "workspace_files_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the workspace files settings.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

function limit(request: Request, userId: string) {
  return applyRateLimit({
    category: "workspace_files_settings",
    key: buildRateLimitKey(["workspace-files", userId]),
    limit: 60,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

function actorFor(
  request: Request,
  session: { user: { email: string; id: string } },
) {
  return {
    email: session.user.email,
    id: session.user.id,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
  };
}

/** The provider chosen for files, or the answer to send when there is none. */
async function filesOrResponse() {
  const found = await getFilesProviderChoice();

  if (!found) {
    return NextResponse.json(
      { error: "No workspace provider is chosen for files." },
      { status: 409 },
    );
  }

  return { files: found.files, provider: found.choice };
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    const found = await filesOrResponse();

    if (found instanceof Response) {
      return found;
    }

    return NextResponse.json({
      view: await getWorkspaceFilesSettingsView(found.provider, found.files),
    });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  try {
    const found = await filesOrResponse();

    if (found instanceof Response) {
      return found;
    }

    const view = await saveWorkspaceFilesSettings(
      await request.json().catch(() => null),
      found.provider,
      found.files,
      actorFor(request, session),
    );

    return NextResponse.json({ view });
  } catch (error) {
    if (error instanceof WorkspaceFilesSettingsError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: 400 },
      );
    }

    if (error instanceof WorkspaceSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await limit(request, session.user.id);

  if (limited) {
    return limited;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const input = parsed.data;

    switch (input.action) {
      case "check":
        return NextResponse.json({ checks: await checkWorkspaceFiles() });
      case "list_exports":
        return NextResponse.json({
          exports: await listWorkspaceExports(undefined, {
            status: input.status,
          }),
        });
      case "retry_export":
        return NextResponse.json({
          result: await retryWorkspaceExport(
            input.envelopeId,
            actorFor(request, session),
          ),
        });
    }
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
