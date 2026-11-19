import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  getSealSettingsView,
  saveSealSettings,
  SealSettingsError,
  testTimestampServer,
} from "@/lib/seal-setup";
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
import { isHostedMode } from "@/lib/utils/env";

// Settings, Seal & timestamp: the timestamp server, the seal certificate
// (the install's own or an uploaded .p12), and a test of a timestamp
// server. Administrators only. The certificate itself is downloaded from
// ./certificate.

const noStore = { "cache-control": "private, no-store" };

const actionSchema = z.object({
  action: z.literal("test_timestamp"),
  url: z.string().trim().max(2048).optional(),
});

async function authorize(request: Request, limit: number) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  // The hosted service seals with its operator's certificate.
  if (isHostedMode()) {
    return NextResponse.json(
      { error: "The seal is managed by the service on this site." },
      { headers: noStore, status: 409 },
    );
  }

  const limited = await applyRateLimit({
    category: "seal_settings",
    key: buildRateLimitKey(["seal-settings", session.user.id]),
    limit,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  return limited ?? session;
}

function failure(request: Request, error: unknown, userId: string) {
  if (error instanceof SealSettingsError) {
    return NextResponse.json(
      { error: error.message, fieldErrors: error.fieldErrors },
      { headers: noStore, status: 400 },
    );
  }

  logRouteError(error, {
    category: "seal_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the seal settings.",
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
    return NextResponse.json(
      { view: await getSealSettingsView() },
      { headers: noStore },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await authorize(request, 30);

  if (session instanceof Response) {
    return session;
  }

  try {
    const view = await saveSealSettings(
      await request.json().catch(() => null),
      {
        email: session.user.email,
        id: session.user.id,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
    );

    return NextResponse.json({ view }, { headers: noStore });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

/** { action: "test_timestamp", url? } asks the server for a real token. */
export async function POST(request: Request) {
  const session = await authorize(request, 30);

  if (session instanceof Response) {
    return session;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unknown action." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    return NextResponse.json(
      { result: await testTimestampServer(parsed.data.url) },
      { headers: noStore },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
