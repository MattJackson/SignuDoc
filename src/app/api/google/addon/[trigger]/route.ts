import { NextResponse } from "next/server";

import {
  addonSiteUrl,
  addonWorkspaceDomains,
  readStoredAddonConfig,
} from "@/lib/google-addon";
import {
  pushCard,
  rateLimitedResponse,
  signInCard,
} from "@/lib/integrations/google/addon/cards";
import {
  addonEndpointUrl,
  isAddonTrigger,
} from "@/lib/integrations/google/addon/config";
import {
  AddonEventError,
  parseAddonEvent,
  readBearerToken,
} from "@/lib/integrations/google/addon/event";
import { handleAddonTrigger } from "@/lib/integrations/google/addon/handlers";
import { getGoogleJwks } from "@/lib/integrations/google/addon/id-token";
import { findAddonUser } from "@/lib/integrations/google/addon/users";
import {
  AddonRequestError,
  authenticateAddonRequest,
} from "@/lib/integrations/google/addon/verify-request";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { consumeRateLimit, peekRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { readLimitedBody } from "@/lib/utils/limited-body";

// The Google Workspace add-on's endpoints, which Google calls when someone
// opens SignuDoc in Gmail or Drive, opens an email, selects files, or
// presses a button on one of its cards. The deployment JSON
// (lib/integrations/google/addon/manifest.ts) names one URL per trigger.
//
// Every request is checked before anything else is read: Google's system
// ID token for the add-on's service account, then the user ID token
// (verify-request.ts). With the add-on not set up in Settings, the
// endpoints answer 404, as if they were not there. Answers are cards
// (cards.ts), and never cached.

// Converting a Word file and storing a document can take a while.
export const maxDuration = 60;

type AddonRouteContext = { params: Promise<{ trigger: string }> };

// An event object is a few kilobytes; the tokens are most of it.
const MAX_EVENT_BYTES = 256 * 1024;
// Per person, generous for clicking around the panel.
const USER_LIMIT = 120;
const USER_WINDOW_MS = 10 * 60 * 1000;
// Requests that fail verification, from wherever they come.
const FAILURE_LIMIT = 60;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const NO_STORE = { "cache-control": "private, no-store" };

function answer(body: unknown, status = 200) {
  return NextResponse.json(body, { headers: NO_STORE, status });
}

export async function POST(request: Request, context: AddonRouteContext) {
  const { trigger } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const path = getRequestPathname(request);

  if (!isAddonTrigger(trigger)) {
    return answer({ error: "Not found." }, 404);
  }

  const siteUrl = addonSiteUrl();
  const config = await readStoredAddonConfig();

  if (!config.ready || !siteUrl) {
    return answer({ error: "Not found." }, 404);
  }

  // Only requests that fail verification are counted, so a working add-on
  // never reaches this; something guessing at tokens does.
  const failureKey = `google-addon-failures:${ipAddress ?? "unknown"}`;
  const failures = await peekRateLimit({
    key: failureKey,
    limit: FAILURE_LIMIT,
  });

  if (!failures.allowed) {
    return answer({ error: "Too many requests." }, 429);
  }

  const raw = await readLimitedBody(request, MAX_EVENT_BYTES);

  if (!raw) {
    return answer({ error: "The request is too large." }, 413);
  }

  let event;

  try {
    event = parseAddonEvent(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch (error) {
    if (error instanceof AddonEventError || error instanceof SyntaxError) {
      return answer({ error: "The request could not be read." }, 400);
    }

    throw error;
  }

  const workspaceDomains = await addonWorkspaceDomains();
  let caller;

  try {
    caller = await authenticateAddonRequest({
      // The system ID token's audience is the URL Google was told to
      // call, which is this site's address and this path.
      audiences: [addonEndpointUrl(siteUrl, trigger)],
      bearerToken: readBearerToken(request.headers.get("authorization")),
      config,
      jwks: getGoogleJwks(),
      systemIdToken: event.systemIdToken,
      userIdToken: event.userIdToken,
      workspaceDomains,
    });
  } catch (error) {
    if (!(error instanceof AddonRequestError)) {
      logRouteError(error, {
        category: "google_addon_failure",
        ipAddress,
        message: "Verifying a Google Workspace add-on request failed.",
        path,
      });

      return answer({ error: "Something went wrong." }, 500);
    }

    if (error.problem !== "outside_workspace") {
      await consumeRateLimit({
        key: failureKey,
        limit: FAILURE_LIMIT,
        windowMs: FAILURE_WINDOW_MS,
      });
    }

    logSecurityEvent("warn", {
      category: "google_addon_rejected",
      ipAddress,
      message: error.message,
      metadata: { problem: error.problem, token: error.tokenProblem },
      path,
    });

    if (error.problem === "outside_workspace") {
      return answer(pushCard(signInCard(siteUrl, "outside_workspace")));
    }

    return answer({ error: "Unauthorized." }, 401);
  }

  const limited = await consumeRateLimit({
    key: `google-addon:${caller.email}`,
    limit: USER_LIMIT,
    windowMs: USER_WINDOW_MS,
  });

  if (!limited.allowed) {
    return answer(rateLimitedResponse(trigger), 200);
  }

  try {
    const lookup = await findAddonUser(caller, workspaceDomains);

    if (lookup.kind !== "found") {
      return answer(pushCard(signInCard(siteUrl, lookup.kind)));
    }

    const response = await handleAddonTrigger(trigger, {
      event,
      links: { actionUrl: addonEndpointUrl(siteUrl, "action"), siteUrl },
      log: (message, error) => {
        logRouteError(error, {
          category: "google_addon_failure",
          ipAddress,
          message,
          path,
          userId: lookup.user.id,
        });
      },
      user: lookup.user,
    });

    return answer(response);
  } catch (error) {
    logRouteError(error, {
      category: "google_addon_failure",
      ipAddress,
      message: "Unexpected failure in the Google Workspace add-on.",
      path,
    });

    return answer({ error: "Something went wrong." }, 500);
  }
}
