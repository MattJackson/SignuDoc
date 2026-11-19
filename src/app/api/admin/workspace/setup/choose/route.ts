import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getRequestPathname } from "@/lib/security/request";
import { isHostedMode } from "@/lib/utils/env";
import { submitSetupChoice } from "@/lib/workspace/workspace-setup";

// The administrator's answer to a choice an automatic workspace setup is
// waiting for, such as the Google Cloud project
// (/api/admin/workspace/setup/run). Only the person running the setup can
// answer for it; the provider checks the answer is one it offered.

const bodySchema = z.object({
  choice: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._:-]+$/),
  runId: z.string().trim().min(16).max(100),
});

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  if (isHostedMode()) {
    return NextResponse.json(
      { error: "The hosted service runs its own workspace setup." },
      { status: 409 },
    );
  }

  const limited = await applyRateLimit({
    category: "workspace_setup",
    key: buildRateLimitKey(["workspace-setup-choose", session.user.id]),
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
      { error: "Choose one from the list." },
      { status: 400 },
    );
  }

  try {
    const taken = await submitSetupChoice({
      choice: parsed.data.choice,
      runId: parsed.data.runId,
      userId: session.user.id,
    });

    return taken
      ? NextResponse.json({ ok: true })
      : NextResponse.json(
          { error: "A choice was already made for this setup." },
          { status: 409 },
        );
  } catch (error) {
    logRouteError(error, {
      category: "workspace_setup_failure",
      message: "Could not record the setup choice.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
