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
import {
  getWorkspaceAdminView,
  parseWorkspaceSettingsInput,
  WorkspaceSettingsInputError,
} from "@/lib/workspace/admin-view";
import {
  configuredWorkspaceProviders,
  getWorkspaceContext,
  resolveCapabilityProvider,
} from "@/lib/workspace/registry";
import {
  readWorkspaceSettings,
  saveWorkspaceSettings,
  WorkspaceSettingsError,
} from "@/lib/workspace/settings";
import type {
  WorkspaceCheck,
  WorkspaceCheckTarget,
} from "@/lib/workspace/types";

// The workspace part of Settings: which provider, the directory and the
// administrator group, and the checks an administrator can run on them.
// Administrators only. GET shows, PUT saves, POST runs one part's checks.

const CHECKABLE: readonly WorkspaceCheckTarget[] = [
  "identity",
  "directory",
  "adminGroup",
];

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "workspace_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the workspace settings.",
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
    category: "workspace_settings",
    key: buildRateLimitKey(["workspace-settings", userId]),
    limit: 30,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({ view: await getWorkspaceAdminView() });
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
    const update = parseWorkspaceSettingsInput(
      await request.json().catch(() => null),
    );

    await saveWorkspaceSettings(update, {
      email: session.user.email,
      id: session.user.id,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
    });

    return NextResponse.json({
      view: await getWorkspaceAdminView(
        process.env,
        await readWorkspaceSettings(),
      ),
    });
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
  const target = CHECKABLE.find((item) => item === body?.target);

  if (!target) {
    return NextResponse.json({ error: "Unknown check." }, { status: 400 });
  }

  try {
    const context = await getWorkspaceContext();
    // The identity of every provider in use; the directory and the group
    // through the provider that serves the directory.
    const providers =
      target === "identity"
        ? configuredWorkspaceProviders(context.settings)
        : [resolveCapabilityProvider("directory", context.settings).provider];
    const checks: WorkspaceCheck[] = [];

    for (const provider of providers) {
      if (!provider) {
        continue;
      }

      // Checks run as the administrator: the directory looks them up, and
      // the group check asks whether they are in it.
      const results = await provider
        .setup(context)
        .check(target, { email: session.user.email });

      checks.push(
        ...results.map((check) => ({
          ...check,
          name:
            providers.length > 1
              ? `${provider.label}: ${check.name}`
              : check.name,
        })),
      );
    }

    if (checks.length === 0) {
      return NextResponse.json(
        { error: "Choose a workspace provider and save first." },
        { status: 400 },
      );
    }

    return NextResponse.json({ checks });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
