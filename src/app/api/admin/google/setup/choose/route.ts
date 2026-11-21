import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import { submitProjectChoice } from "@/lib/google-workspace-setup";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getRequestPathname } from "@/lib/security/request";
import { isHostedMode } from "@/lib/utils/env";

// The Cloud project the administrator chose for an automatic Google
// Workspace setup that is waiting for it (api/admin/google/setup/run).
// Only the person running the setup can answer for it.

const bodySchema = z.object({
  choice: z.union([
    z.object({ create: z.literal(true) }),
    z.object({
      create: z.literal(false),
      projectId: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    }),
  ]),
  runId: z.string().trim().min(16).max(100),
});

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  if (isHostedMode()) {
    return NextResponse.json(
      { error: "The hosted service runs its own Google setup." },
      { status: 409 },
    );
  }

  const limited = await applyRateLimit({
    category: "google_workspace_setup",
    key: buildRateLimitKey(["google-setup-choose", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a project from the list." },
      { status: 400 },
    );
  }

  try {
    const taken = await submitProjectChoice({
      choice: parsed.data.choice,
      runId: parsed.data.runId,
      userId: session.user.id,
    });

    return taken
      ? NextResponse.json({ ok: true })
      : NextResponse.json(
          { error: "A project was already chosen for this setup." },
          { status: 409 },
        );
  } catch (error) {
    logRouteError(error, {
      category: "google_workspace_setup_failure",
      message: "Could not record the project choice.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
