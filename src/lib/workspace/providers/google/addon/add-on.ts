import {
  logRouteError,
  logSecurityEvent,
} from "../../../../security/logging.ts";
import {
  consumeRateLimit,
  peekRateLimit,
} from "../../../../security/rate-limit.ts";
import {
  getClientIpAddress,
  getRequestPathname,
} from "../../../../security/request.ts";
import type { EnvSource } from "../../../../utils/env.ts";
import { readLimitedBody } from "../../../../utils/limited-body.ts";
import {
  addInEndpointUrl,
  addInSiteUrl,
  findAddInAccount,
  type AddInAccountLookup,
} from "../../../add-in-support.ts";
import type { WorkspaceSettings } from "../../../settings.ts";
import type { WorkspaceAddIn } from "../../../types.ts";
import {
  pushCard,
  rateLimitedResponse,
  signInCard,
  type RenderActions,
} from "./cards.ts";
import { isAddonAction, readAddonConfig, type AddonConfig } from "./config.ts";
import { AddonEventError, parseAddonEvent, readBearerToken } from "./event.ts";
import { handleAddonAction } from "./handlers.ts";
import { getGoogleJwks, type JwksCache } from "./id-token.ts";
import {
  AddonRequestError,
  authenticateAddonRequest,
} from "./verify-request.ts";

// The Gmail and Drive add-on as the workspace's add-in (types.ts,
// WorkspaceAddIn). Google calls /api/workspace/add-in/<action> when someone
// opens SignuDoc in Gmail or Drive, opens an email, selects files, or
// presses a button on one of its cards; the deployment JSON (manifest.ts)
// names one URL per action.
//
// Every request is checked before anything else is read: Google's system
// ID token for the add-on's service account, then the user ID token
// (verify-request.ts), then the account with the verified address
// (add-in-support.ts). Answers are cards (cards.ts), never cached.
//
// The add-in is offered only once the add-on's service account and client
// ID are set; before that the route answers 404.

// An event object is a few kilobytes; the tokens are most of it.
const MAX_EVENT_BYTES = 256 * 1024;
// Per person, generous for clicking around the panel.
const USER_LIMIT = 120;
const USER_WINDOW_MS = 10 * 60 * 1000;
// Requests that fail verification, from wherever they come.
const FAILURE_LIMIT = 60;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const NO_STORE = { "cache-control": "private, no-store" } as const;

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { headers: NO_STORE, status });
}

export type GoogleAddInOptions = {
  env?: EnvSource;
  /** For tests: who has the verified address. */
  findAccount?: (email: string) => Promise<AddInAccountLookup>;
  /** For tests: Google's signing keys. */
  jwks?: JwksCache;
  /** For tests: what a verified request does. */
  run?: typeof handleAddonAction;
  settings?: WorkspaceSettings | null;
};

/** The add-on, or null until its service account and client ID are set. */
export function createGoogleAddIn({
  env = process.env,
  findAccount = (email) => findAddInAccount(email),
  jwks,
  run = handleAddonAction,
  settings = null,
}: GoogleAddInOptions = {}): WorkspaceAddIn | null {
  const config = readAddonConfig(env, settings);
  const siteUrl = addInSiteUrl(env);

  if (!config.ready || !siteUrl) {
    return null;
  }

  return {
    handle: (action, request) =>
      handleAddonRequest(action, request, {
        config,
        findAccount,
        jwks: jwks ?? getGoogleJwks(),
        run,
        siteUrl,
      }),
  };
}

async function handleAddonRequest(
  action: string,
  request: Request,
  {
    config,
    findAccount,
    jwks,
    run,
    siteUrl,
  }: {
    config: AddonConfig;
    findAccount: (email: string) => Promise<AddInAccountLookup>;
    jwks: JwksCache;
    run: typeof handleAddonAction;
    siteUrl: string;
  },
): Promise<Response> {
  if (!isAddonAction(action) || request.method !== "POST") {
    return answer({ error: "Not found." }, 404);
  }

  const ipAddress = getClientIpAddress(request.headers);
  const path = getRequestPathname(request);

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

  let caller;

  try {
    caller = await authenticateAddonRequest({
      // The system ID token's audience is the URL Google was told to
      // call, which is this site's address and this path.
      audiences: [addInEndpointUrl(siteUrl, action)],
      bearerToken: readBearerToken(request.headers.get("authorization")),
      config,
      jwks,
      systemIdToken: event.systemIdToken,
      userIdToken: event.userIdToken,
    });
  } catch (error) {
    if (!(error instanceof AddonRequestError)) {
      logRouteError(error, {
        category: "workspace_add_in_failure",
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
      category: "workspace_add_in_rejected",
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
    return answer(rateLimitedResponse(action));
  }

  const lookup = await findAccount(caller.email);

  if (lookup.kind !== "found") {
    return answer(pushCard(signInCard(siteUrl, lookup.kind)));
  }

  const response: RenderActions = await run(action, {
    account: lookup.account,
    event,
    links: { actionUrl: addInEndpointUrl(siteUrl, "action"), siteUrl },
    log: (message, error) => {
      logRouteError(error, {
        category: "workspace_add_in_failure",
        ipAddress,
        message,
        path,
        userId: lookup.account.id,
      });
    },
  });

  return answer(response);
}
