import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getOnboardingState,
  isOnboardingStepId,
  markOnboardingStep,
} from "@/lib/onboarding/steps";
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
import { checkStorage } from "@/lib/storage-check";

// Onboarding: where each step stands, skipping or confirming a step, and
// the storage check. Administrators only.

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark"),
    mark: z.enum(["confirmed", "skipped"]).nullable(),
    stepId: z.string().refine(isOnboardingStepId),
  }),
  z.object({ action: z.literal("check_storage") }),
]);

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  return NextResponse.json({ steps: await getOnboardingState() });
}

export async function POST(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "onboarding_action",
    key: buildRateLimitKey(["onboarding", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    if (parsed.data.action === "check_storage") {
      return NextResponse.json({ storage: await checkStorage() });
    }

    const { mark, stepId } = parsed.data;

    if (!isOnboardingStepId(stepId)) {
      return NextResponse.json({ error: "Unknown step." }, { status: 400 });
    }

    await markOnboardingStep(stepId, mark, {
      email: session.user.email,
      id: session.user.id,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
    });

    return NextResponse.json({ steps: await getOnboardingState() });
  } catch (error) {
    logRouteError(error, {
      category: "onboarding_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure in onboarding.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
