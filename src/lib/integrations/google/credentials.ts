import { createSign } from "node:crypto";

import { readEnv, type EnvSource } from "../../utils/env.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "./endpoints.ts";

// Access tokens for Google APIs (Cloud Storage, Drive, the Workspace
// directory), shared by every Google integration in the app.
//
// Two ways to get them, with no Google SDK:
//
// - "metadata": on Cloud Run, GKE or Compute Engine, from the metadata
//   server, as the service account the app runs as. No key to store. This is
//   the default whenever the app runs on Google Cloud.
// - "service-account-key": from a service account key in
//   GOOGLE_SERVICE_ACCOUNT_KEY (the JSON file, or the same in base64), for
//   running anywhere else.
//
// A request can name a subject, a Workspace user to act as through
// domain-wide delegation. With a key the key signs the assertion itself; on
// the metadata server the IAM Credentials API signs it, which needs the
// service account to hold Service Account Token Creator on itself.

export const GOOGLE_SCOPES = {
  cloudPlatform: "https://www.googleapis.com/auth/cloud-platform",
  devstorageReadWrite: "https://www.googleapis.com/auth/devstorage.read_write",
  directoryGroupReadonly:
    "https://www.googleapis.com/auth/admin.directory.group.readonly",
  directoryUserReadonly:
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  drive: "https://www.googleapis.com/auth/drive",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  driveLabelsReadonly: "https://www.googleapis.com/auth/drive.labels.readonly",
} as const;

export type GoogleCredentialsSource = "metadata" | "service-account-key";

export type GoogleAccessTokenRequest = {
  scopes: readonly string[];
  /** A Workspace user to act as, through domain-wide delegation. */
  subject?: string;
};

export interface GoogleCredentials {
  readonly source: GoogleCredentialsSource;
  getAccessToken(request: GoogleAccessTokenRequest): Promise<string>;
  /** The service account the app acts as. */
  getServiceAccountEmail(): Promise<string>;
}

export class GoogleCredentialsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GoogleCredentialsError";
  }
}

type FetchLike = typeof fetch;

type CreateGoogleCredentialsOptions = {
  env?: EnvSource;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long a request to Google may take, in milliseconds. */
  timeoutMs?: number;
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type CachedToken = { accessToken: string; expiresAtMs: number };

const METADATA_BASE_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
// A token is used again until this long before it runs out.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ASSERTION_LIFETIME_SECONDS = 3600;

const PROJECT_NUMBER_URL =
  "http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id";
const PROJECT_NUMBER_TIMEOUT_MS = 2000;

let cachedProjectNumber: string | null = null;

/**
 * The number of the Google Cloud project the app runs in, from the metadata
 * server, to prefill setup forms. Null when not on Google Cloud or when it
 * cannot be read; it never throws. A found number is kept for later calls.
 */
export async function readGoogleProjectNumber({
  env = process.env,
  fetchImpl = fetch,
}: { env?: EnvSource; fetchImpl?: FetchLike } = {}): Promise<string | null> {
  if (cachedProjectNumber) {
    return cachedProjectNumber;
  }

  if (!isOnGoogleCloud(env)) {
    return null;
  }

  try {
    const response = await fetchImpl(PROJECT_NUMBER_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(PROJECT_NUMBER_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const number = (await response.text()).trim();

    if (!/^\d{6,20}$/.test(number)) {
      return null;
    }

    cachedProjectNumber = number;

    return number;
  } catch {
    return null;
  }
}

/** Forgets the cached project number, for tests. */
export function resetGoogleProjectNumberCache() {
  cachedProjectNumber = null;
}

/** True when the app runs somewhere with a Google metadata server. */
export function isOnGoogleCloud(env: EnvSource = process.env): boolean {
  return Boolean(
    readEnv(env, "K_SERVICE") ||
    readEnv(env, "CLOUD_RUN_JOB") ||
    readEnv(env, "GOOGLE_CLOUD_PROJECT") ||
    readEnv(env, "GOOGLE_CREDENTIALS")?.toLowerCase() === "metadata",
  );
}

export function parseServiceAccountKey(value: string): ServiceAccountKey {
  const trimmedValue = value.trim();
  const json = trimmedValue.startsWith("{")
    ? trimmedValue
    : Buffer.from(trimmedValue, "base64").toString("utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GoogleCredentialsError(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key (JSON or base64 JSON).",
      { cause: error },
    );
  }

  const key = parsed as Partial<ServiceAccountKey>;

  if (
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string"
  ) {
    throw new GoogleCredentialsError(
      "GOOGLE_SERVICE_ACCOUNT_KEY needs client_email and private_key.",
    );
  }

  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: typeof key.token_uri === "string" ? key.token_uri : undefined,
  };
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function buildClaims(input: {
  issuer: string;
  nowMs: number;
  scopes: readonly string[];
  subject?: string;
  tokenUri: string;
}) {
  const issuedAt = Math.floor(input.nowMs / 1000);

  return {
    aud: input.tokenUri,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    iat: issuedAt,
    iss: input.issuer,
    scope: input.scopes.join(" "),
    ...(input.subject ? { sub: input.subject } : {}),
  };
}

export function signJwtWithKey(
  claims: Record<string, unknown>,
  privateKey: string,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");

  signer.update(`${header}.${payload}`);

  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    // The body can echo what was sent, so only the status is kept.
    throw new GoogleCredentialsError(`${what} failed with ${response.status}.`);
  }

  return response.json();
}

function cacheKey(request: GoogleAccessTokenRequest): string {
  return `${request.subject ?? ""}|${[...request.scopes].sort().join(" ")}`;
}

export function createGoogleCredentials({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
}: CreateGoogleCredentialsOptions = {}): GoogleCredentials | null {
  const keyValue = readEnv(env, "GOOGLE_SERVICE_ACCOUNT_KEY");
  const key = keyValue ? parseServiceAccountKey(keyValue) : null;

  if (!key && !isOnGoogleCloud(env)) {
    return null;
  }

  const cache = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<CachedToken>>();
  let metadataEmail: Promise<string> | null = null;

  async function exchangeAssertion(
    assertion: string,
    tokenUri: string,
  ): Promise<CachedToken> {
    // The assertion names Google's token endpoint; a test stand-in
    // (endpoints.ts) answers in its place.
    const response = await fetchImpl(googleUrl(tokenUri, env), {
      body: new URLSearchParams({ assertion, grant_type: JWT_BEARER_GRANT }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: googleTimeoutSignal(timeoutMs),
    });

    return toCachedToken(await readJson(response, "Google token exchange"));
  }

  function toCachedToken(body: unknown): CachedToken {
    const token = body as { access_token?: unknown; expires_in?: unknown };

    if (typeof token.access_token !== "string") {
      throw new GoogleCredentialsError("Google returned no access token.");
    }

    const expiresInSeconds =
      typeof token.expires_in === "number" ? token.expires_in : 300;

    return {
      accessToken: token.access_token,
      expiresAtMs: now() + expiresInSeconds * 1000,
    };
  }

  async function metadataGet(pathAndQuery: string): Promise<Response> {
    return fetchImpl(`${METADATA_BASE_URL}/${pathAndQuery}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: googleTimeoutSignal(timeoutMs),
    });
  }

  async function getServiceAccountEmail(): Promise<string> {
    if (key) {
      return key.client_email;
    }

    metadataEmail ??= metadataGet("email").then(async (response) => {
      if (!response.ok) {
        throw new GoogleCredentialsError(
          `Reading the service account from the metadata server failed with ${response.status}.`,
        );
      }

      return (await response.text()).trim();
    });

    try {
      return await metadataEmail;
    } catch (error) {
      metadataEmail = null;
      throw error;
    }
  }

  async function fetchToken(
    request: GoogleAccessTokenRequest,
  ): Promise<CachedToken> {
    if (key) {
      const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
      const assertion = signJwtWithKey(
        buildClaims({
          issuer: key.client_email,
          nowMs: now(),
          scopes: request.scopes,
          subject: request.subject,
          tokenUri,
        }),
        key.private_key,
      );

      return exchangeAssertion(assertion, tokenUri);
    }

    if (!request.subject) {
      const response = await metadataGet(
        `token?scopes=${encodeURIComponent(request.scopes.join(","))}`,
      );

      return toCachedToken(
        await readJson(response, "Metadata server token request"),
      );
    }

    // Acting as a Workspace user without a key: IAM signs the assertion
    // for the service account the app runs as.
    const email = await getServiceAccountEmail();
    const iamToken = await getAccessToken({
      scopes: [GOOGLE_SCOPES.cloudPlatform],
    });
    const signResponse = await fetchImpl(
      googleUrl(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`,
        env,
      ),
      {
        body: JSON.stringify({
          payload: JSON.stringify(
            buildClaims({
              issuer: email,
              nowMs: now(),
              scopes: request.scopes,
              subject: request.subject,
              tokenUri: DEFAULT_TOKEN_URI,
            }),
          ),
        }),
        headers: {
          authorization: `Bearer ${iamToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: googleTimeoutSignal(timeoutMs),
      },
    );
    const signed = (await readJson(signResponse, "IAM signJwt")) as {
      signedJwt?: unknown;
    };

    if (typeof signed.signedJwt !== "string") {
      throw new GoogleCredentialsError("IAM signJwt returned no JWT.");
    }

    return exchangeAssertion(signed.signedJwt, DEFAULT_TOKEN_URI);
  }

  async function getAccessToken(
    request: GoogleAccessTokenRequest,
  ): Promise<string> {
    if (request.scopes.length === 0) {
      throw new GoogleCredentialsError("At least one scope is required.");
    }

    const keyForRequest = cacheKey(request);
    const cached = cache.get(keyForRequest);

    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now()) {
      return cached.accessToken;
    }

    let pending = inFlight.get(keyForRequest);

    if (!pending) {
      pending = fetchToken(request).finally(() => {
        inFlight.delete(keyForRequest);
      });
      inFlight.set(keyForRequest, pending);
    }

    const token = await pending;

    cache.set(keyForRequest, token);

    return token.accessToken;
  }

  return {
    getAccessToken,
    getServiceAccountEmail,
    source: key ? "service-account-key" : "metadata",
  };
}

let sharedCredentials: GoogleCredentials | null | undefined;

/**
 * The app's Google credentials, made once per process, or null when neither
 * a key nor a metadata server is available.
 */
export function getGoogleCredentials(): GoogleCredentials | null {
  if (sharedCredentials === undefined) {
    sharedCredentials = createGoogleCredentials();
  }

  return sharedCredentials;
}
