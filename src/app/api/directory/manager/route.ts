import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  describeSenderManagerProblem,
  findSenderManager,
  loadManagerPolicy,
  managerPolicyAppliesTo,
} from "@/lib/manager-policy";
import { readStoredSettings } from "@/lib/settings";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";

// The signed-in sender's own manager, from the Workspace directory, for
// "Add my manager" on the signers page and the "Sender's manager" role of a
// template. Only the sender's own entry is read, and only the manager's
// name and address are returned. Also says whether the administrator
// suggests or requires the manager's approval for this sender
// (manager-policy.ts), so the page can say so.

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "directory_search",
    key: buildRateLimitKey(["directory-manager", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 5 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const [policy, settings] = await Promise.all([
      loadManagerPolicy(),
      readStoredSettings(),
    ]);
    const part11 = settings?.part11Mode ?? false;
    const applies =
      !part11 && (await managerPolicyAppliesTo(session.user.id, policy));
    const found = await findSenderManager(session.user.email);

    return NextResponse.json(
      {
        // Approvers are not offered in Part 11 mode, so neither is this.
        available: !part11,
        manager: found.status === "found" ? found.manager : null,
        message:
          found.status === "found" ? null : describeSenderManagerProblem(found),
        policy: applies ? policy.mode : "off",
        status: found.status,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    logRouteError(error, {
      category: "directory_manager_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The sender's manager could not be looked up.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Your manager could not be looked up." },
      { status: 500 },
    );
  }
}
