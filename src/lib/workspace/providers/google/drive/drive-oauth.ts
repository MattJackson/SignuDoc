import { createHash, randomBytes } from "node:crypto";

import { readSsoConfig } from "../../../../auth/sso.ts";
import { readEnv, type EnvSource } from "../../../../utils/env.ts";
import { FilesConnectionError } from "../../../types.ts";
import { GOOGLE_SCOPES } from "../credentials.ts";
import type { FetchLike } from "./drive-api.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "../endpoints.ts";

// Each person's own permission for Google Drive.
//
// Only drive.file is asked for: the app can then see and change only the
// files the person picks with the Picker, and the files it makes itself (a
// temporary copy while converting). openid and email come along so the
// answer says which Google account agreed.
//
// The flow is the authorization code flow with PKCE (S256) and offline
// access, so a refresh token comes back. The app keeps the state and the
// verifier in a short-lived encrypted cookie (workspace/files.ts), and the
// refresh token encrypted per person (drive-tokens.ts).
// https://developers.google.com/identity/protocols/oauth2/web-server
//
// The OAuth client is GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.
// When sign-in already uses Google (SSO_ISSUER is https://accounts.google.com)
// its client is used instead of a second one, as incremental authorization.

export const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_ISSUER = "https://accounts.google.com";

export const DRIVE_CONNECT_SCOPES: readonly string[] = [
  "openid",
  "email",
  GOOGLE_SCOPES.driveFile,
];

export type DriveOAuthClient = { clientId: string; clientSecret: string };

/** Google no longer accepts the refresh token or code. */
export class InvalidGrantError extends Error {
  constructor() {
    super("Google no longer accepts this Drive connection.");
    this.name = "InvalidGrantError";
  }
}

/** The OAuth client people connect Drive with, or null when there is none. */
export function readDriveOAuthClient(
  env: EnvSource = process.env,
): DriveOAuthClient | null {
  const clientId = readEnv(env, "GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = readEnv(env, "GOOGLE_OAUTH_CLIENT_SECRET");

  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  const sso = readSsoConfig(env);

  return sso?.issuer === GOOGLE_ISSUER
    ? { clientId: sso.clientId, clientSecret: sso.clientSecret }
    : null;
}

export function createPkcePair(): { challenge: string; verifier: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  return { challenge, verifier };
}

export function buildAuthorizationUrl(input: {
  client: DriveOAuthClient;
  codeChallenge: string;
  env?: EnvSource;
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

  return `${googleUrl(GOOGLE_AUTHORIZATION_URL, input.env)}?${params.toString()}`;
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
  timeoutMs: number,
  env: EnvSource,
): Promise<TokenResponse> {
  let response: Response;

  try {
    response = await fetchImpl(googleUrl(GOOGLE_TOKEN_URL, env), {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: googleTimeoutSignal(timeoutMs),
    });
  } catch {
    throw new FilesConnectionError("failed", "Google could not be reached.");
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
    // invalid_grant: the refresh token was revoked or expired, or the code
    // was used. Only the error code is kept; the description can echo input.
    if (payload?.error === "invalid_grant") {
      throw new InvalidGrantError();
    }

    throw new FilesConnectionError(
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
  env?: EnvSource;
  fetchImpl?: FetchLike;
  redirectUri: string;
  timeoutMs?: number;
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
    input.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS,
    input.env ?? process.env,
  );
}

export function refreshAccessToken(input: {
  client: DriveOAuthClient;
  env?: EnvSource;
  fetchImpl?: FetchLike;
  refreshToken: string;
  timeoutMs?: number;
}): Promise<TokenResponse> {
  return postToken(
    input.fetchImpl ?? fetch,
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
    input.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS,
    input.env ?? process.env,
  );
}

/** Asks Google to forget the token. True when Google confirmed it. */
export async function revokeToken(
  token: string,
  {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
  }: { env?: EnvSource; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const response = await fetchImpl(googleUrl(GOOGLE_REVOKE_URL, env), {
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: googleTimeoutSignal(timeoutMs),
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
