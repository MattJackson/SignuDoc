import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

// Verifies ID tokens signed by Google, with node:crypto and no library.
//
// The Workspace add-on sends two on every request
// (https://developers.google.com/workspace/add-ons/guides/alternate-runtimes):
//
// - the system ID token, in the Authorization header (and again as
//   authorizationEventObject.systemIdToken). It is issued to the add-on's
//   own service account, with the endpoint's URL as its audience, and
//   proves the request came from Google for this add-on.
// - the user ID token, authorizationEventObject.userIdToken, issued for the
//   add-on's OAuth client, naming the person using the add-on.
//
// Both are RS256 JWTs whose keys Google publishes as a JSON Web Key Set
// (https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken).
// The keys are cached for as long as Google's Cache-Control says, and read
// again early when a token names a key that is not in the cache (Google
// rotates them), but not more than once a minute.

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ID_TOKEN_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

// Clocks are a little apart; a token is taken this long either side.
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_KEYS_LIFETIME_MS = 60 * 60 * 1000;
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;

export type GoogleIdTokenClaims = {
  aud: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
  hd?: string;
  iat: number;
  iss: string;
  name?: string;
  sub: string;
  [claim: string]: unknown;
};

export type IdTokenProblem =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "keys_unavailable";

export class IdTokenError extends Error {
  readonly problem: IdTokenProblem;

  constructor(problem: IdTokenProblem, message: string) {
    super(message);
    this.name = "IdTokenError";
    this.problem = problem;
  }
}

type FetchLike = typeof fetch;

export type JwksCacheOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  url?: string;
};

export interface JwksCache {
  /** The key with this id, reading the set again when it is not known. */
  getKey(kid: string): Promise<KeyObject | null>;
}

function maxAgeMs(cacheControl: string | null): number {
  const match = /max-age=(\d+)/i.exec(cacheControl ?? "");

  return match
    ? Number.parseInt(match[1]!, 10) * 1000
    : DEFAULT_KEYS_LIFETIME_MS;
}

export function createJwksCache({
  fetchImpl = fetch,
  now = Date.now,
  url = GOOGLE_JWKS_URL,
}: JwksCacheOptions = {}): JwksCache {
  let keys = new Map<string, KeyObject>();
  let expiresAtMs = 0;
  let fetchedAtMs = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    fetchedAtMs = now();

    const response = await fetchImpl(url);

    if (!response.ok) {
      throw new IdTokenError(
        "keys_unavailable",
        `Google's signing keys could not be read (${String(response.status)}).`,
      );
    }

    const body = (await response.json()) as { keys?: unknown };
    const next = new Map<string, KeyObject>();

    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      const candidate = jwk as JsonWebKey & { alg?: string; kid?: unknown };

      if (typeof candidate.kid !== "string" || candidate.kty !== "RSA") {
        continue;
      }

      try {
        next.set(
          candidate.kid,
          createPublicKey({ format: "jwk", key: candidate }),
        );
      } catch {
        // A key that cannot be read is left out; the others still count.
      }
    }

    keys = next;
    expiresAtMs = now() + maxAgeMs(response.headers.get("cache-control"));
  }

  function load(): Promise<void> {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return {
    async getKey(kid) {
      if (now() >= expiresAtMs) {
        await load();
      }

      const known = keys.get(kid);

      if (known) {
        return known;
      }

      // A key Google added since the set was read. Asked again, but not
      // for every token that names a key Google never had.
      if (now() - fetchedAtMs >= MIN_REFETCH_INTERVAL_MS) {
        await load();
      }

      return keys.get(kid) ?? null;
    },
  };
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export type VerifyIdTokenInput = {
  /** Any one of these is accepted as the token's audience. */
  audiences: readonly string[];
  jwks: JwksCache;
  now?: () => number;
  token: string;
};

/**
 * Checks the token's signature against Google's keys, its issuer, its
 * audience and its lifetime, and returns its claims. Throws IdTokenError
 * saying which check failed. Callers check the claims that matter to them
 * (email, email_verified, hd) themselves.
 */
export async function verifyGoogleIdToken({
  audiences,
  jwks,
  now = Date.now,
  token,
}: VerifyIdTokenInput): Promise<GoogleIdTokenClaims> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new IdTokenError("malformed", "The ID token is missing or too long.");
  }

  const parts = token.split(".");

  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new IdTokenError("malformed", "The ID token is not a JWT.");
  }

  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  let header: { alg?: unknown; kid?: unknown };
  let claims: Partial<GoogleIdTokenClaims>;

  try {
    header = decodeSegment(headerPart) as typeof header;
    claims = decodeSegment(payloadPart) as typeof claims;
  } catch {
    throw new IdTokenError("malformed", "The ID token cannot be read.");
  }

  if (typeof header !== "object" || header === null) {
    throw new IdTokenError("malformed", "The ID token has no header.");
  }

  // Only what Google signs with. "none" and HMAC are never accepted.
  if (header.alg !== "RS256") {
    throw new IdTokenError(
      "unsupported_algorithm",
      "The ID token is not signed with RS256.",
    );
  }

  if (typeof header.kid !== "string") {
    throw new IdTokenError("unknown_key", "The ID token names no key.");
  }

  const key = await jwks.getKey(header.kid);

  if (!key) {
    throw new IdTokenError(
      "unknown_key",
      "The ID token is signed with a key Google does not publish.",
    );
  }

  const signed = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, "base64url"),
  );

  if (!signed) {
    throw new IdTokenError(
      "bad_signature",
      "The ID token's signature is wrong.",
    );
  }

  if (typeof claims !== "object" || claims === null) {
    throw new IdTokenError("malformed", "The ID token has no claims.");
  }

  if (
    typeof claims.iss !== "string" ||
    !(GOOGLE_ID_TOKEN_ISSUERS as readonly string[]).includes(claims.iss)
  ) {
    throw new IdTokenError("wrong_issuer", "The ID token is not Google's.");
  }

  if (typeof claims.aud !== "string" || !audiences.includes(claims.aud)) {
    throw new IdTokenError(
      "wrong_audience",
      "The ID token was issued for something else.",
    );
  }

  const nowSeconds = Math.floor(now() / 1000);

  if (
    typeof claims.exp !== "number" ||
    claims.exp + CLOCK_SKEW_SECONDS < nowSeconds
  ) {
    throw new IdTokenError("expired", "The ID token has expired.");
  }

  if (
    typeof claims.iat === "number" &&
    claims.iat - CLOCK_SKEW_SECONDS > nowSeconds
  ) {
    throw new IdTokenError("not_yet_valid", "The ID token is from the future.");
  }

  if (typeof claims.sub !== "string") {
    throw new IdTokenError("malformed", "The ID token names nobody.");
  }

  return claims as GoogleIdTokenClaims;
}

let sharedJwks: JwksCache | null = null;

/** One cache of Google's keys per process. */
export function getGoogleJwks(): JwksCache {
  sharedJwks ??= createJwksCache();

  return sharedJwks;
}
