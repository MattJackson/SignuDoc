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
//    with a verified email address, from a Google Workspace account (it has
//    an hd claim). A personal Google account can carry any address that
//    once received a confirmation email, so its address is not trusted to
//    name an account here.
//
// Matching the person to an account is the app's (workspace/add-in-support.ts).

export type AddonCaller = {
  email: string;
  /** The Workspace the account belongs to. */
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
};

function tokenProblem(error: unknown): string | null {
  return error instanceof IdTokenError ? error.problem : null;
}

// Not being able to fetch Google's keys is the server's trouble, not a bad
// request: it passes through as it is, so the route answers 500 and does not
// count it against the caller.
function isInfrastructureFailure(error: unknown): boolean {
  return (
    !(error instanceof IdTokenError) || error.problem === "keys_unavailable"
  );
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
    if (error instanceof AddonRequestError || isInfrastructureFailure(error)) {
      throw error;
    }

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
    if (isInfrastructureFailure(error)) {
      throw error;
    }

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

  const hostedDomain =
    typeof user.hd === "string" ? user.hd.trim().toLowerCase() : "";

  if (!hostedDomain) {
    throw new AddonRequestError(
      "outside_workspace",
      "The Google account is not a Google Workspace account.",
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
