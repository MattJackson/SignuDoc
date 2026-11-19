import { NextResponse } from "next/server";

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
import { WorkspaceSettingsInputError } from "@/lib/workspace/admin-view";
import { WorkspaceSettingsError } from "@/lib/workspace/settings";
import {
  checkSetupStep,
  isSetupCheckTarget,
  saveSetupGuideValues,
} from "@/lib/workspace/workspace-setup";

// The step-by-step setup's own actions, for the provider the setup page
// shows (?provider=, or the default one): PUT saves what was pasted into a
// step's fields, POST runs a step's checks as the administrator.
// Administrators only. Every saved change is in the install's audit trail.

export const maxDuration = 60;

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "workspace_setup_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the workspace setup guide.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

async function limit(request: Request, userId: string) {
  return applyRateLimit({
    category: "workspace_setup",
    key: buildRateLimitKey(["workspace-setup-guide", userId]),
    limit: 60,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

function providerOf(body: unknown): string | null {
  const provider =
    body && typeof body === "object" && "provider" in body
      ? (body as { provider: unknown }).provider
      : null;

  return typeof provider === "string" ? provider : null;
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

  const body: unknown = await request.json().catch(() => null);

  try {
    const changed = await saveSetupGuideValues(providerOf(body), body, {
      email: session.user.email,
      id: session.user.id,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
    });

    return NextResponse.json({ changed });
  } catch (error) {
    if (
      error instanceof WorkspaceSettingsInputError ||
      error instanceof WorkspaceSettingsError
    ) {
      return NextResponse.json(
        {
          error: error.message,
          fieldErrors:
            error instanceof WorkspaceSettingsInputError
              ? error.fieldErrors
              : {},
        },
        { status: 400 },
      );
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

  const body = (await request.json().catch(() => null)) as {
    target?: unknown;
  } | null;
  const target = body?.target;

  if (!isSetupCheckTarget(target)) {
    return NextResponse.json({ error: "Unknown check." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      checks: await checkSetupStep(
        providerOf(body),
        target,
        session.user.email,
      ),
    });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
