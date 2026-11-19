import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readEnv, type EnvSource } from "../../../utils/env.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "./endpoints.ts";

// Access tokens for Google APIs (the Workspace directory, Drive, the setup's
// Cloud calls), shared by every Google part of the app. The site's Google
// identity comes only from where it runs: nothing secret is kept in the
// database.
//
// Three ways to get them, with no Google SDK, tried in this order:
//
// - "service-account-key": a service account key in
//   GOOGLE_SERVICE_ACCOUNT_KEY (the JSON file, or the same in base64).
// - "impersonation": GOOGLE_IMPERSONATE_SERVICE_ACCOUNT names a service
//   account, and the gcloud application-default login mounted into the
//   container (GOOGLE_APPLICATION_CREDENTIALS, or
//   ~/.config/gcloud/application_default_credentials.json) may act as it.
//   The login's refresh token gets a user token, and the IAM Credentials
//   API turns that into the service account's tokens. For organizations
//   that forbid service account keys.
// - "metadata": on Cloud Run, GKE or Compute Engine, from the metadata
//   server, as the service account the app runs as. No key to store.
//
// A request can name a subject, a Workspace user to act as through
// domain-wide delegation. With a key the key signs the assertion itself; on
// the metadata server the IAM Credentials API signs it, which needs the
// service account to hold Service Account Token Creator on itself.

export const GOOGLE_SCOPES = {
  cloudPlatform: "https://www.googleapis.com/auth/cloud-platform",
  directoryGroupReadonly:
    "https://www.googleapis.com/auth/admin.directory.group.readonly",
  directoryUserReadonly:
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  drive: "https://www.googleapis.com/auth/drive",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  driveLabelsReadonly: "https://www.googleapis.com/auth/drive.labels.readonly",
} as const;

export type GoogleCredentialsSource =
  "impersonation" | "metadata" | "service-account-key";

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
  /** Reads the gcloud login file; null when it is not there. */
  readFile?: (file: string) => string | null;
  /** How long a request to Google may take, in milliseconds. */
  timeoutMs?: number;
};

/** The refresh-token login gcloud writes for application-default use. */
type UserLogin = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
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
let cachedProjectId: string | null = null;
// A failed lookup is not tried again for this long, so a metadata server
// that hangs costs one wait, not one per request.
const FAILED_LOOKUP_MS = 30_000;
let projectNumberFailedAt = Number.NEGATIVE_INFINITY;
let projectIdFailedAt = Number.NEGATIVE_INFINITY;

/**
 * The number of the Google Cloud project the app runs in, from the metadata
 * server, to prefill setup forms. Null when not on Google Cloud or when it
 * cannot be read; it never throws. A found number is kept for later calls,
 * and a failure is remembered for a short while.
 */
export async function readGoogleProjectNumber({
  env = process.env,
  fetchImpl = fetch,
}: { env?: EnvSource; fetchImpl?: FetchLike } = {}): Promise<string | null> {
  if (cachedProjectNumber) {
    return cachedProjectNumber;
  }

  if (
    !isOnGoogleCloud(env) ||
    Date.now() - projectNumberFailedAt < FAILED_LOOKUP_MS
  ) {
    return null;
  }

  try {
    const response = await fetchImpl(PROJECT_NUMBER_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(PROJECT_NUMBER_TIMEOUT_MS),
    });
    const number = response.ok ? (await response.text()).trim() : "";

    if (!/^\d{6,20}$/.test(number)) {
      projectNumberFailedAt = Date.now();

      return null;
    }

    cachedProjectNumber = number;

    return number;
  } catch {
    projectNumberFailedAt = Date.now();

    return null;
  }
}

const PROJECT_ID_URL =
  "http://metadata.google.internal/computeMetadata/v1/project/project-id";

/**
 * The ID of the Google Cloud project the app runs in, from the metadata
 * server, or GOOGLE_CLOUD_PROJECT. Null when neither is there; never throws.
 * Kept like the project number.
 */
export async function readGoogleProjectId({
  env = process.env,
  fetchImpl = fetch,
}: { env?: EnvSource; fetchImpl?: FetchLike } = {}): Promise<string | null> {
  const fromEnv = readEnv(env, "GOOGLE_CLOUD_PROJECT");

  if (fromEnv) {
    return fromEnv;
  }

  if (cachedProjectId) {
    return cachedProjectId;
  }

  if (
    !isOnGoogleCloud(env) ||
    Date.now() - projectIdFailedAt < FAILED_LOOKUP_MS
  ) {
    return null;
  }

  try {
    const response = await fetchImpl(PROJECT_ID_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(PROJECT_NUMBER_TIMEOUT_MS),
    });
    const id = response.ok ? (await response.text()).trim() : "";

    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id)) {
      projectIdFailedAt = Date.now();

      return null;
    }

    cachedProjectId = id;

    return id;
  } catch {
    projectIdFailedAt = Date.now();

    return null;
  }
}

/** Forgets the cached project number and ID, for tests. */
export function resetGoogleProjectNumberCache() {
  cachedProjectNumber = null;
  cachedProjectId = null;
  projectNumberFailedAt = Number.NEGATIVE_INFINITY;
  projectIdFailedAt = Number.NEGATIVE_INFINITY;
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

function readFileOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Where gcloud keeps the application-default login, in this order. */
export function applicationDefaultCredentialsPaths(
  env: EnvSource = process.env,
): string[] {
  const configDir =
    readEnv(env, "CLOUDSDK_CONFIG") ??
    path.join(readEnv(env, "HOME") ?? homedir(), ".config", "gcloud");

  return [
    readEnv(env, "GOOGLE_APPLICATION_CREDENTIALS"),
    path.join(configDir, "application_default_credentials.json"),
  ].filter((file): file is string => Boolean(file));
}

/**
 * The gcloud login to impersonate with, and the service account it names
 * when it was made with --impersonate-service-account. Null when no such
 * file can be read.
 */
export function readApplicationDefaultLogin(
  env: EnvSource = process.env,
  readFile: (file: string) => string | null = readFileOrNull,
): { login: UserLogin; serviceAccount: string | null } | null {
  for (const file of applicationDefaultCredentialsPaths(env)) {
    const text = readFile(file);

    if (!text) {
      continue;
    }

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }

    const impersonated = parsed.type === "impersonated_service_account";
    const source = (impersonated ? parsed.source_credentials : parsed) as
      Record<string, unknown> | undefined;
    const target =
      impersonated &&
      typeof parsed.service_account_impersonation_url === "string"
        ? (/serviceAccounts\/([^/:]+):generateAccessToken/.exec(
            parsed.service_account_impersonation_url,
          )?.[1] ?? null)
        : null;

    if (
      source?.type === "authorized_user" &&
      typeof source.client_id === "string" &&
      typeof source.client_secret === "string" &&
      typeof source.refresh_token === "string"
    ) {
      return {
        login: {
          client_id: source.client_id,
          client_secret: source.client_secret,
          refresh_token: source.refresh_token,
        },
        serviceAccount: target ? decodeURIComponent(target) : null,
      };
    }
  }

  return null;
}

type ChosenIdentity =
  | { key: ServiceAccountKey; source: "service-account-key" }
  | { email: string; login: UserLogin; source: "impersonation" }
  | { source: "metadata" };

function chooseIdentity(
  env: EnvSource,
  readFile: (file: string) => string | null,
): ChosenIdentity | null {
  const envKey = readEnv(env, "GOOGLE_SERVICE_ACCOUNT_KEY");

  if (envKey) {
    return {
      key: parseServiceAccountKey(envKey),
      source: "service-account-key",
    };
  }

  const envTarget = readEnv(env, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT");

  if (envTarget) {
    const adc = readApplicationDefaultLogin(env, readFile);

    if (!adc) {
      throw new GoogleCredentialsError(
        "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT is set, but no gcloud application-default login is mounted into the container.",
      );
    }

    return { email: envTarget, login: adc.login, source: "impersonation" };
  }

  return isOnGoogleCloud(env) ? { source: "metadata" } : null;
}

export function createGoogleCredentials({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  readFile = readFileOrNull,
  timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
}: CreateGoogleCredentialsOptions = {}): GoogleCredentials | null {
  const identity = chooseIdentity(env, readFile);

  if (!identity) {
    return null;
  }

  const key = "key" in identity ? identity.key : null;
  const impersonation = identity.source === "impersonation" ? identity : null;
  let userToken: CachedToken | null = null;
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

    if (impersonation) {
      return impersonation.email;
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

  /** The gcloud login's own token, from its refresh token. */
  async function loginToken(login: UserLogin): Promise<string> {
    if (userToken && userToken.expiresAtMs - REFRESH_MARGIN_MS > now()) {
      return userToken.accessToken;
    }

    const response = await fetchImpl(googleUrl(DEFAULT_TOKEN_URI, env), {
      body: new URLSearchParams({
        client_id: login.client_id,
        client_secret: login.client_secret,
        grant_type: "refresh_token",
        refresh_token: login.refresh_token,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: googleTimeoutSignal(timeoutMs),
    });

    userToken = toCachedToken(
      await readJson(response, "Refreshing the gcloud login"),
    );

    return userToken.accessToken;
  }

  /** Has IAM sign a delegation assertion for the service account. */
  async function signJwtAs(
    email: string,
    bearer: string,
    request: GoogleAccessTokenRequest,
  ): Promise<CachedToken> {
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
          authorization: `Bearer ${bearer}`,
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

  /** The service account's token, asked for with the gcloud login. */
  async function impersonatedToken(
    email: string,
    bearer: string,
    request: GoogleAccessTokenRequest,
  ): Promise<CachedToken> {
    const response = await fetchImpl(
      googleUrl(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`,
        env,
      ),
      {
        body: JSON.stringify({ lifetime: "3600s", scope: request.scopes }),
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: googleTimeoutSignal(timeoutMs),
      },
    );
    const body = (await readJson(response, "IAM generateAccessToken")) as {
      accessToken?: unknown;
      expireTime?: unknown;
    };

    if (typeof body.accessToken !== "string") {
      throw new GoogleCredentialsError(
        "IAM generateAccessToken returned no token.",
      );
    }

    const expiresAt =
      typeof body.expireTime === "string"
        ? Date.parse(body.expireTime)
        : Number.NaN;

    return {
      accessToken: body.accessToken,
      expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : now() + 300_000,
    };
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

    if (impersonation) {
      const bearer = await loginToken(impersonation.login);

      return request.subject
        ? signJwtAs(impersonation.email, bearer, request)
        : impersonatedToken(impersonation.email, bearer, request);
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

    return signJwtAs(email, iamToken, request);
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
    source: identity.source,
  };
}

let sharedCredentials:
  { credentials: GoogleCredentials | null; fingerprint: string } | undefined;
// The gcloud login file is looked for again after this long, so one
// mounted later is found without reading the file on every call.
const LOGIN_RECHECK_MS = 60_000;
let loginCheckedAt = Number.NEGATIVE_INFINITY;
let loginPresent = false;

/**
 * The app's Google credentials, or null when there are none. Made again
 * only when what they come from changes: the environment, or a gcloud login
 * mounted after the app started.
 */
export function getGoogleCredentials(): GoogleCredentials | null {
  if (
    readEnv(process.env, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") &&
    Date.now() - loginCheckedAt > LOGIN_RECHECK_MS
  ) {
    loginCheckedAt = Date.now();
    loginPresent = readApplicationDefaultLogin() !== null;
  }

  const fingerprint = JSON.stringify([
    readEnv(process.env, "GOOGLE_SERVICE_ACCOUNT_KEY") ?? "",
    readEnv(process.env, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") ?? "",
    loginPresent,
  ]);

  if (sharedCredentials?.fingerprint !== fingerprint) {
    // A bad key or a missing login throws here, and again on the next
    // call.
    const credentials = createGoogleCredentials();

    sharedCredentials = { credentials, fingerprint };
  }

  return sharedCredentials.credentials;
}

/** Forgets the shared credentials, for tests. */
export function resetGoogleCredentials() {
  sharedCredentials = undefined;
  loginCheckedAt = Number.NEGATIVE_INFINITY;
}

/**
 * The credentials for an environment: the shared ones for the process's
 * own, made fresh for any other (tests, a check with other values).
 */
export function googleCredentialsFor(
  env: EnvSource = process.env,
): GoogleCredentials | null {
  return env === process.env
    ? getGoogleCredentials()
    : createGoogleCredentials({ env });
}
