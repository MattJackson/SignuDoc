import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import { secureCookies } from "@/lib/drive-routes";
import { runAutomaticSetup } from "@/lib/google-workspace-setup";
import {
  openSetupState,
  SETUP_COOKIE,
  SETUP_COOKIE_PATH,
  type SetupEvent,
} from "@/lib/integrations/google/workspace-setup";
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
import { readCookie } from "@/lib/signer-checks";
import { isHostedMode } from "@/lib/utils/env";

// Runs the automatic Google Workspace setup with the code Google sent back
// to /settings/google-setup. The answer is a stream of JSON lines, one per
// step as it starts and ends, so the page shows each one live; one of them
// offers the Cloud projects, and the page answers through
// api/admin/google/setup/choose. The token lives only for this request and
// is revoked at the end.

// runAutomaticSetup holds everything, the code exchange and the wait for
// the project choice included, to SETUP_TIME_BUDGET_MS (190 s,
// workspace-setup.ts) and starts no Google request after it. One request
// still under way (15 s) and the revoke (15 s) end well before this limit,
// which is Vercel's without fluid compute and Cloud Run's usual timeout.
export const maxDuration = 300;

const bodySchema = z.object({
  code: z.string().trim().min(1).max(2048),
  state: z.string().trim().min(1).max(200),
});

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function refuse(request: Request, message: string, status: number) {
  const response = NextResponse.json({ error: message }, { status });

  response.cookies.set(SETUP_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: SETUP_COOKIE_PATH,
    sameSite: "lax",
    secure: secureCookies(request),
  });

  return response;
}

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
    key: buildRateLimitKey(["google-setup-run", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const cookie = openSetupState(
    readCookie(request.headers.get("cookie"), SETUP_COOKIE),
  );

  if (
    !parsed.success ||
    !cookie ||
    !sameValue(cookie.state, parsed.data.state) ||
    cookie.userId !== session.user.id
  ) {
    return refuse(
      request,
      "This sign-in has expired or was started elsewhere. Start the setup again.",
      400,
    );
  }

  const { code } = parsed.data;
  const { exportDrive, returnTo, verifier } = cookie;
  const encoder = new TextEncoder();
  const actor = {
    email: session.user.email,
    id: session.user.id,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
  };
  // Once the page has gone away (a closed tab), what would be sent is
  // dropped; the run itself carries on and still revokes the token.
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      open = false;
    },
    async start(controller) {
      const send = (
        event: SetupEvent | { returnTo: string; type: "start" },
      ) => {
        if (!open) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      send({ returnTo, type: "start" });

      try {
        await runAutomaticSetup({
          actor,
          code,
          codeVerifier: verifier,
          emit: send,
          exportDrive,
        });
      } catch (error) {
        logRouteError(error, {
          category: "google_workspace_setup_failure",
          ipAddress: actor.ipAddress,
          message: "Unexpected failure in the automatic Google setup.",
          path: getRequestPathname(request),
          userId: session.user.id,
        });
        send({ message: "The setup stopped unexpectedly.", type: "refused" });
        send({ ok: false, revoked: false, type: "finished" });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // Already closed by the other side.
          }
        }
      }
    },
  });
  const response = new NextResponse(stream, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      // Proxies should pass each line on as it comes.
      "x-accel-buffering": "no",
    },
  });

  // The code can be used once; so can the cookie.
  response.cookies.set(SETUP_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: SETUP_COOKIE_PATH,
    sameSite: "lax",
    secure: secureCookies(request),
  });

  return response;
}
