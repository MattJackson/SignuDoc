import { createHash, randomBytes } from "node:crypto";

import { readSsoConfig, type StoredSignInSettings } from "../../auth/sso.ts";
import { safeReturnPath as safeSitePath } from "../../return-path.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../../services/seal-identity.ts";
import { resolveAuthUrl, type EnvSource } from "../../utils/env.ts";
import { GOOGLE_SCOPES } from "./credentials.ts";
import type { FetchLike } from "./drive-api.ts";
import { googleUrl } from "./endpoints.ts";

// Each person's own permission for Google Drive, asked for on top of
// Google sign-in (incremental authorization), with the same OAuth client.
//
// Only drive.file is asked for: the app can then see and change only the
// files the person opens with it (the Picker, Drive's "Open with") and the
// files it makes itself (a temporary copy while converting). openid and
// email were already granted at sign-in and come along so the answer says
// which Google account agreed.
//
// The flow is the authorization code flow with PKCE (S256) and a state
// value, both kept in an encrypted, short-lived, HttpOnly cookie, and
// offline access, so a refresh token comes back. The refresh token is
// stored encrypted per person (drive-tokens.ts) and access tokens are made
// from it on the server when needed.
// https://developers.google.com/identity/protocols/oauth2/web-server

export const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const DRIVE_CONNECT_SCOPES: readonly string[] = [
  "openid",
  "email",
  GOOGLE_SCOPES.driveFile,
];

/** Where Google sends people back to: add it to the OAuth client. */
export const DRIVE_CALLBACK_PATH = "/api/google/drive/callback";
export const DRIVE_OAUTH_COOKIE = "signudoc_drive_oauth";
export const DRIVE_OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

const STATE_CONTEXT = "signudoc/google-drive-oauth-state/v1";

export type DriveOAuthClient = { clientId: string; clientSecret: string };

export type DriveAuthorizationErrorCode =
  "failed" | "invalid_grant" | "not_configured" | "not_connected";

export class DriveAuthorizationError extends Error {
  readonly code: DriveAuthorizationErrorCode;

  constructor(code: DriveAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "DriveAuthorizationError";
    this.code = code;
  }
}

/**
 * The Google sign-in OAuth client, from Settings or the SSO_* variables,
 * or null when sign-in is not set up with Google as the provider.
 */
export function readDriveOAuthClient(
  env: EnvSource = process.env,
  stored: StoredSignInSettings | null = null,
): DriveOAuthClient | null {
  const sso = readSsoConfig(env, stored);

  if (!sso || !sso.google) {
    return null;
  }

  return { clientId: sso.clientId, clientSecret: sso.clientSecret };
}

/** This site's callback address, or null when it does not know its URL. */
export function driveRedirectUri(env: EnvSource = process.env): string | null {
  try {
    const url = resolveAuthUrl(env)?.replace(/\/+$/, "");

    return url ? `${url}${DRIVE_CALLBACK_PATH}` : null;
  } catch {
    return null;
  }
}

export function createPkcePair(): { challenge: string; verifier: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  return { challenge, verifier };
}

export function buildAuthorizationUrl(input: {
  client: DriveOAuthClient;
  codeChallenge: string;
  loginHint?: string | null;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: input.client.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    // Asked every time, so Google always hands back a refresh token, even
    // to someone who connected before and disconnected.
    prompt: "consent",
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: DRIVE_CONNECT_SCOPES.join(" "),
    state: input.state,
  });

  if (input.loginHint) {
    params.set("login_hint", input.loginHint);
  }

  return `${googleUrl(GOOGLE_AUTHORIZATION_URL)}?${params.toString()}`;
}

export type OAuthStateCookie = {
  createdAt: number;
  returnTo: string;
  state: string;
  userId: string;
  verifier: string;
};

function stateKey(env: EnvSource): Buffer {
  return secretKeyFor(STATE_CONTEXT, env);
}

export function sealOAuthState(
  value: OAuthStateCookie,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(JSON.stringify(value), stateKey(env));
}

/** The cookie's contents, or null when it is missing, forged or too old. */
export function openOAuthState(
  sealed: string | null | undefined,
  env: EnvSource = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): OAuthStateCookie | null {
  if (!sealed) {
    return null;
  }

  const json = decryptPrivateKey(sealed, stateKey(env));

  if (!json) {
    return null;
  }

  try {
    const value = JSON.parse(json) as Partial<OAuthStateCookie>;

    if (
      typeof value.state !== "string" ||
      typeof value.verifier !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.returnTo !== "string" ||
      typeof value.createdAt !== "number" ||
      nowSeconds - value.createdAt > DRIVE_OAUTH_COOKIE_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return value as OAuthStateCookie;
  } catch {
    return null;
  }
}

/** A path on this site to come back to, or the fallback. */
export function safeReturnPath(
  value: string | null | undefined,
  fallback = "/envelopes/new",
): string {
  return safeSitePath(value, fallback);
}

export type TokenResponse = {
  accessToken: string;
  expiresInSeconds: number;
  idToken: string | null;
  refreshToken: string | null;
  scope: string;
};

async function postToken(
  fetchImpl: FetchLike,
  body: URLSearchParams,
): Promise<TokenResponse> {
  let response: Response;

  try {
    response = await fetchImpl(googleUrl(GOOGLE_TOKEN_URL), {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    throw new DriveAuthorizationError("failed", "Google could not be reached.");
  }

  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
  } | null;

  if (!response.ok || typeof payload?.access_token !== "string") {
    // invalid_grant: the refresh token was revoked, expired or the code was
    // used. Only the error code is kept; the description can echo input.
    if (payload?.error === "invalid_grant") {
      throw new DriveAuthorizationError(
        "invalid_grant",
        "Google no longer accepts this Drive connection.",
      );
    }

    throw new DriveAuthorizationError(
      "failed",
      `Google's token endpoint answered with ${String(response.status)}.`,
    );
  }

  return {
    accessToken: payload.access_token,
    expiresInSeconds:
      typeof payload.expires_in === "number" ? payload.expires_in : 300,
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}

export function exchangeAuthorizationCode(input: {
  client: DriveOAuthClient;
  code: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
  redirectUri: string;
}): Promise<TokenResponse> {
  return postToken(
    input.fetchImpl ?? fetch,
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  );
}

export function refreshAccessToken(input: {
  client: DriveOAuthClient;
  fetchImpl?: FetchLike;
  refreshToken: string;
}): Promise<TokenResponse> {
  return postToken(
    input.fetchImpl ?? fetch,
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  );
}

/** Asks Google to forget the token. True when Google confirmed it. */
export async function revokeToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(googleUrl(GOOGLE_REVOKE_URL), {
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    // 400 means Google already does not know the token: as good as revoked.
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

export type IdTokenClaims = { email: string; sub: string };

/**
 * The account in an ID token from Google's token endpoint. The token came
 * straight from Google over TLS in answer to this server's own request, so
 * its signature does not need checking (OpenID Connect Core 3.1.3.7).
 */
export function readIdTokenClaims(
  idToken: string | null,
): IdTokenClaims | null {
  const payload = idToken?.split(".")[1];

  if (!payload) {
    return null;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { email?: unknown; email_verified?: unknown; sub?: unknown };

    if (
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string" ||
      claims.email_verified === false
    ) {
      return null;
    }

    return { email: claims.email.toLowerCase(), sub: claims.sub };
  } catch {
    return null;
  }
}

/** Whether Google granted drive.file this time. */
export function grantsDriveFile(scope: string): boolean {
  return scope.split(/\s+/).includes(GOOGLE_SCOPES.driveFile);
}
