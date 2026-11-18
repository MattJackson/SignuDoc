import {
  splitWorkspaceDomains,
  type WorkspaceDomains,
} from "../../../auth/sso.ts";
import type { AddonConfig } from "./config.ts";
import {
  IdTokenError,
  verifyGoogleIdToken,
  type JwksCache,
} from "./id-token.ts";

// Every request to the add-on's endpoints is checked twice before anything
// is read or answered:
//
// 1. That Google sent it, for this add-on: the system ID token in the
//    Authorization header is signed by Google, its audience is the URL that
//    was called, and its email is the add-on's own service account, verified.
//    This is the check in Google's guide, "Validate requests from Google"
//    (https://developers.google.com/workspace/add-ons/guides/alternate-runtimes).
//    When the header is missing, the same token in the event object is used
//    instead; it is the same token, and still checked the same way.
// 2. Who is using it: the user ID token, for the add-on's OAuth client,
//    with a verified email address. Its hd claim (the Workspace an account
//    belongs to) must be one of this site's Workspace domains when any are
//    known, as for Google sign-in (auth/sso.ts).
//
// Mapping the person to an account here is users.ts.

export type AddonCaller = {
  email: string;
  /** The Workspace the account belongs to; empty for a personal account. */
  hostedDomain: string;
  name: string | null;
  subject: string;
};

export type AddonRequestProblem =
  "not_configured" | "not_from_google" | "no_user" | "outside_workspace";

export class AddonRequestError extends Error {
  readonly problem: AddonRequestProblem;
  readonly tokenProblem: string | null;

  constructor(
    problem: AddonRequestProblem,
    message: string,
    tokenProblem: string | null = null,
  ) {
    super(message);
    this.name = "AddonRequestError";
    this.problem = problem;
    this.tokenProblem = tokenProblem;
  }
}

export type AuthenticateAddonRequestInput = {
  /** The URLs the system ID token may be issued for: this endpoint's. */
  audiences: readonly string[];
  /** The Authorization header's bearer token, or an empty string. */
  bearerToken: string;
  config: AddonConfig;
  jwks: JwksCache;
  now?: () => number;
  /** The event's own copy of the system ID token. */
  systemIdToken: string;
  userIdToken: string;
  workspaceDomains: readonly string[] | WorkspaceDomains;
};

function tokenProblem(error: unknown): string | null {
  return error instanceof IdTokenError ? error.problem : null;
}

/**
 * Google's signing keys could not be read: nothing is known about the
 * request, so it is not called forged. The error passes on as it is, and the
 * route answers it as a server problem without counting it against the
 * caller's failures.
 */
function rethrowKeysUnavailable(error: unknown): void {
  if (error instanceof IdTokenError && error.problem === "keys_unavailable") {
    throw error;
  }
}

/** Throws AddonRequestError unless Google sent the request for a known user. */
export async function authenticateAddonRequest({
  audiences,
  bearerToken,
  config,
  jwks,
  now = Date.now,
  systemIdToken,
  userIdToken,
  workspaceDomains,
}: AuthenticateAddonRequestInput): Promise<AddonCaller> {
  if (!config.ready || !config.serviceAccountEmail || !config.oauthClientId) {
    throw new AddonRequestError(
      "not_configured",
      "The add-on's service account and client ID are not set.",
    );
  }

  const systemToken = bearerToken || systemIdToken;

  try {
    const system = await verifyGoogleIdToken({
      audiences: [...audiences, ...config.extraAudiences],
      jwks,
      now,
      token: systemToken,
    });

    if (
      system.email_verified !== true ||
      typeof system.email !== "string" ||
      system.email.toLowerCase() !== config.serviceAccountEmail
    ) {
      throw new AddonRequestError(
        "not_from_google",
        "The request was not signed by this add-on's service account.",
      );
    }
  } catch (error) {
    if (error instanceof AddonRequestError) {
      throw error;
    }

    rethrowKeysUnavailable(error);

    throw new AddonRequestError(
      "not_from_google",
      "The request's system ID token did not verify.",
      tokenProblem(error),
    );
  }

  let user;

  try {
    user = await verifyGoogleIdToken({
      audiences: [config.oauthClientId],
      jwks,
      now,
      token: userIdToken,
    });
  } catch (error) {
    rethrowKeysUnavailable(error);

    throw new AddonRequestError(
      "no_user",
      "The request's user ID token did not verify.",
      tokenProblem(error),
    );
  }

  if (user.email_verified !== true || typeof user.email !== "string") {
    throw new AddonRequestError(
      "no_user",
      "The user ID token has no verified email address.",
    );
  }

  const { domains, noneAllowed } = splitWorkspaceDomains(workspaceDomains);
  const hostedDomain =
    typeof user.hd === "string" ? user.hd.trim().toLowerCase() : "";

  if (
    !hostedDomain ||
    noneAllowed ||
    (domains.length > 0 && !domains.includes(hostedDomain))
  ) {
    throw new AddonRequestError(
      "outside_workspace",
      "The Google account is not in this organization's Workspace.",
    );
  }

  return {
    email: user.email.trim().toLowerCase(),
    hostedDomain,
    name:
      typeof user.name === "string" && user.name.trim()
        ? user.name.trim()
        : null,
    subject: user.sub,
  };
}
