import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { handleCloud } from "./fake-cloud.ts";
import { handleDirectory } from "./fake-directory.ts";
import { handleDrive } from "./fake-drive.ts";
import {
  createState,
  escapeHtml,
  findUser,
  randomToken,
  readBody,
  readJsonBody,
  requireScope,
  sendGoogleError,
  sendJson,
  storeDrive,
  storeGroup,
  storeUser,
  type FakeAccessToken,
  type FakeGoogleGroup,
  type FakeGoogleState,
  type FakeGoogleUser,
  type FakeRequest,
  type FakeSharedDrive,
  type StoredFile,
  type StoredUser,
} from "./fake-state.ts";

// A stand-in for the parts of Google the app talks to, for tests: Google
// sign-in (OpenID Connect discovery, the authorization page, the token
// endpoint, JWKS and userinfo), service account tokens (the JWT bearer
// grant, with domain-wide delegation, and IAM signJwt), the Admin SDK
// directory (fake-directory.ts), Drive (fake-drive.ts), and the Cloud and
// Admin SDK calls of the automatic Workspace setup (fake-cloud.ts). One plain Node
// HTTP server on 127.0.0.1, no dependencies.
//
// The app is pointed at it with GOOGLE_OAUTH_BASE_URL and
// GOOGLE_API_BASE_URL (integrations/google/endpoints.ts), both set to the
// server's url; fake.env has them. Its discovery document names Google's
// real issuer, https://accounts.google.com, and signs ID tokens with that
// issuer, so the app checks them exactly as it checks Google's.
//
// The authorization page lists every account, whatever the hd hint says,
// so a test can try an account from another Workspace and see the app turn
// it away. A login_hint naming an account skips the page.
//
// Start it with startFakeGoogle() in a test, or from the command line for
// the end-to-end tests (e2e/support/google-stand-in.ts). /__fake/state shows
// what it holds, and POST /__fake/users, /__fake/groups and /__fake/drives
// add to it from another process.

export const FAKE_GOOGLE_ISSUER = "https://accounts.google.com";

/** The OAuth client the fake knows unless told otherwise. */
export const FAKE_GOOGLE_CLIENT = {
  id: "fake-client-id.apps.googleusercontent.com",
  secret: "fake-client-secret",
};

export const FAKE_SERVICE_ACCOUNT_EMAIL =
  "signudoc@fake-project.iam.gserviceaccount.com";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ACCESS_TOKEN_SECONDS = 3599;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export type FakeServiceAccountKey = {
  client_email: string;
  client_id: string;
  private_key: string;
  private_key_id: string;
  project_id: string;
  token_uri: string;
  type: "service_account";
};

/**
 * A new service account key in the JSON form Google hands out. Its
 * token_uri is Google's unless one is given; the app reaches the fake for
 * it through GOOGLE_OAUTH_BASE_URL either way.
 */
export function createFakeServiceAccountKey(
  clientEmail = FAKE_SERVICE_ACCOUNT_EMAIL,
  tokenUri = "https://oauth2.googleapis.com/token",
): FakeServiceAccountKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  return {
    client_email: clientEmail,
    client_id: `1${String(Date.now()).padStart(20, "0")}`,
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    private_key_id: randomBytes(20).toString("hex"),
    project_id: "fake-project",
    token_uri: tokenUri,
    type: "service_account",
  };
}

export type FakeGoogleOptions = {
  /** OAuth clients allowed to sign people in. FAKE_GOOGLE_CLIENT by default. */
  clients?: Array<{ id: string; secret: string }>;
  /** The Workspace domains the directory lists; every Workspace by default. */
  directoryDomains?: string[];
  drives?: FakeSharedDrive[];
  groups?: FakeGoogleGroup[];
  /** 127.0.0.1 by default. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /**
   * Service account keys whose assertions are checked against their public
   * key. An assertion from any other service account is taken unchecked.
   */
  serviceAccounts?: Array<
    Pick<FakeServiceAccountKey, "client_email" | "private_key">
  >;
  users?: FakeGoogleUser[];
};

export type FakeGoogle = {
  addDrive(drive: FakeSharedDrive): void;
  addGroup(group: FakeGoogleGroup): void;
  addUser(user: FakeGoogleUser): void;
  close(): Promise<void>;
  /** The variables that point the app at this server. */
  env: { GOOGLE_API_BASE_URL: string; GOOGLE_OAUTH_BASE_URL: string };
  /** Files in the fake Drive, newest last. */
  files(): StoredFile[];
  /** An access token for these scopes, as a service account or a user. */
  issueAccessToken(input: {
    scopes: string[];
    serviceAccount?: string;
    user?: string;
  }): string;
  /** The query of the last authorization request, or null. */
  lastAuthorization(): Record<string, string> | null;
  state: FakeGoogleState;
  url: string;
};

type Jwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
};

function decodeJwt(token: string): Jwt | null {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
      signature: Buffer.from(parts[2]!, "base64url"),
      signingInput: `${parts[0]!}.${parts[1]!}`,
    };
  } catch {
    return null;
  }
}

function signJwt(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  kid: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid, typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");

  signer.update(`${header}.${body}`);

  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function verifyJwt(jwt: Jwt, publicKey: KeyObject): boolean {
  const verifier = createVerify("RSA-SHA256");

  verifier.update(jwt.signingInput);

  return verifier.verify(publicKey, jwt.signature);
}

function redirectTo(response: ServerResponse, location: string) {
  response.writeHead(302, { location }).end();
}

function oauthError(
  response: ServerResponse,
  status: number,
  error: string,
  description: string,
) {
  sendJson(response, status, { error, error_description: description });
}

export async function startFakeGoogle(
  options: FakeGoogleOptions = {},
): Promise<FakeGoogle> {
  const state = createState();
  const clients = new Map(
    (options.clients ?? [FAKE_GOOGLE_CLIENT]).map((client) => [
      client.id,
      client.secret,
    ]),
  );
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = createHash("sha256")
    .update(signing.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 16);
  let baseUrl = "";

  for (const domain of options.directoryDomains ?? []) {
    state.directoryDomains.add(domain.trim().toLowerCase());
  }

  for (const user of options.users ?? []) {
    storeUser(state, user);
  }

  for (const group of options.groups ?? []) {
    storeGroup(state, group);
  }

  for (const drive of options.drives ?? []) {
    storeDrive(state, drive);
  }

  for (const account of options.serviceAccounts ?? []) {
    trustServiceAccount(account.client_email, account.private_key);
  }

  function trustServiceAccount(email: string, privateKeyPem: string) {
    const key = createPublicKey(createPrivateKey(privateKeyPem));
    const keys = state.serviceAccountKeys.get(email) ?? [];

    keys.push(key);
    state.serviceAccountKeys.set(email, keys);
  }

  function issueAccessToken(input: {
    client: string;
    scopes: string[];
    serviceAccount: string | null;
    user: string | null;
  }): string {
    const token = randomToken("ya29.fake-");

    state.accessTokens.set(token, {
      ...input,
      expiresAt: Date.now() + ACCESS_TOKEN_SECONDS * 1000,
    });

    return token;
  }

  function idToken(
    user: StoredUser,
    clientId: string,
    nonce: string | null,
  ): string {
    const now = Math.floor(Date.now() / 1000);

    return signJwt(
      {
        aud: clientId,
        azp: clientId,
        email: user.email,
        email_verified: user.emailVerified,
        exp: now + 3600,
        family_name: user.familyName,
        given_name: user.givenName,
        ...(user.hd ? { hd: user.hd } : {}),
        iat: now,
        iss: FAKE_GOOGLE_ISSUER,
        name: `${user.givenName} ${user.familyName}`.trim(),
        ...(nonce ? { nonce } : {}),
        ...(user.picture ? { picture: user.picture } : {}),
        sub: user.id,
      },
      signing.privateKey,
      kid,
    );
  }

  function discovery() {
    return {
      authorization_endpoint: `${baseUrl}/o/oauth2/v2/auth`,
      claims_supported: [
        "aud",
        "email",
        "email_verified",
        "exp",
        "family_name",
        "given_name",
        "hd",
        "iat",
        "iss",
        "name",
        "nonce",
        "picture",
        "sub",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        JWT_BEARER_GRANT,
      ],
      id_token_signing_alg_values_supported: ["RS256"],
      issuer: FAKE_GOOGLE_ISSUER,
      jwks_uri: `${baseUrl}/oauth2/v3/certs`,
      response_types_supported: ["code"],
      revocation_endpoint: `${baseUrl}/revoke`,
      scopes_supported: ["openid", "email", "profile"],
      subject_types_supported: ["public"],
      token_endpoint: `${baseUrl}/token`,
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      userinfo_endpoint: `${baseUrl}/v1/userinfo`,
    };
  }

  /** Sends the browser back to the client with a code for this account. */
  function completeAuthorization(
    response: ServerResponse,
    query: URLSearchParams,
    user: StoredUser,
  ) {
    const code = randomToken("4/fake-");
    const redirect = new URL(query.get("redirect_uri") ?? "");

    state.codes.set(code, {
      accessType: query.get("access_type"),
      clientId: query.get("client_id") ?? "",
      codeChallenge: query.get("code_challenge"),
      codeChallengeMethod: query.get("code_challenge_method"),
      email: user.email,
      expiresAt: Date.now() + CODE_LIFETIME_MS,
      nonce: query.get("nonce"),
      redirectUri: query.get("redirect_uri") ?? "",
      scope: query.get("scope") ?? "openid",
    });
    redirect.searchParams.set("code", code);

    if (query.get("state") !== null) {
      redirect.searchParams.set("state", query.get("state") ?? "");
    }

    redirect.searchParams.set("scope", query.get("scope") ?? "openid");
    redirect.searchParams.set("authuser", "0");
    redirect.searchParams.set("prompt", "none");
    redirectTo(response, redirect.toString());
  }

  function chooserPage(requestId: string, query: URLSearchParams): string {
    const accounts = Array.from(state.users.values())
      .filter((user) => !user.suspended && !user.archived)
      .map(
        (user) =>
          `<li><button type="submit" name="email" value="${escapeHtml(user.email)}">${escapeHtml(`${user.givenName} ${user.familyName}`.trim())} &lt;${escapeHtml(user.email)}&gt;</button></li>`,
      )
      .join("\n");

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Choose an account - Fake Google</title></head>
<body>
<h1>Choose an account</h1>
<p>to continue to ${escapeHtml(query.get("client_id") ?? "")}</p>
<p>Workspace hint: <code>${escapeHtml(query.get("hd") ?? "(none)")}</code></p>
<form method="post" action="/o/oauth2/v2/auth/choose">
<input type="hidden" name="request" value="${escapeHtml(requestId)}">
<ul>
${accounts}
</ul>
<button type="submit" name="cancel" value="1">Cancel</button>
</form>
</body>
</html>`;
  }

  function handleAuthorize(context: FakeRequest) {
    const { query, response } = context;
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";

    state.authorizations.push(Object.fromEntries(query));

    if (!clients.has(clientId)) {
      response
        .writeHead(401, { "content-type": "text/plain" })
        .end("Error 401: invalid_client. The OAuth client was not found.");
      return;
    }

    try {
      new URL(redirectUri);
    } catch {
      response
        .writeHead(400, { "content-type": "text/plain" })
        .end("Error 400: redirect_uri_mismatch.");
      return;
    }

    if (query.get("response_type") !== "code") {
      const redirect = new URL(redirectUri);

      redirect.searchParams.set("error", "unsupported_response_type");
      redirect.searchParams.set("state", query.get("state") ?? "");
      redirectTo(response, redirect.toString());
      return;
    }

    const hinted = query.get("login_hint");
    const user = hinted ? findUser(state, hinted) : null;

    if (user && !user.suspended) {
      completeAuthorization(response, query, user);
      return;
    }

    const requestId = randomToken("req-");

    state.pendingAuthorizations.set(requestId, query);
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(chooserPage(requestId, query));
  }

  function handleChoose(context: FakeRequest) {
    const form = new URLSearchParams(context.body.toString("utf8"));
    const query = state.pendingAuthorizations.get(form.get("request") ?? "");

    if (!query) {
      context.response
        .writeHead(400, { "content-type": "text/plain" })
        .end("This sign-in request has expired. Start again.");
      return;
    }

    state.pendingAuthorizations.delete(form.get("request") ?? "");

    if (form.get("cancel")) {
      const redirect = new URL(query.get("redirect_uri") ?? "");

      redirect.searchParams.set("error", "access_denied");

      if (query.get("state") !== null) {
        redirect.searchParams.set("state", query.get("state") ?? "");
      }

      redirectTo(context.response, redirect.toString());
      return;
    }

    const user = findUser(state, form.get("email") ?? "");

    if (!user || user.suspended) {
      context.response
        .writeHead(400, { "content-type": "text/plain" })
        .end("That account cannot sign in.");
      return;
    }

    completeAuthorization(context.response, query, user);
  }

  /** The client from a Basic header or from the form, if its secret is right. */
  function authenticateClient(
    request: IncomingMessage,
    form: URLSearchParams,
  ): string | null {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const header = request.headers.authorization;

    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");

      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }

    return id && clients.has(id) && clients.get(id) === secret ? id : null;
  }

  function tokenResponse(
    user: StoredUser,
    clientId: string,
    scope: string,
    nonce: string | null,
    withRefreshToken: boolean,
  ) {
    const scopes = scope.split(/\s+/).filter(Boolean);
    const body: Record<string, unknown> = {
      access_token: issueAccessToken({
        client: clientId,
        scopes,
        serviceAccount: null,
        user: user.email,
      }),
      expires_in: ACCESS_TOKEN_SECONDS,
      scope,
      token_type: "Bearer",
    };

    if (scopes.includes("openid")) {
      body.id_token = idToken(user, clientId, nonce);
    }

    if (withRefreshToken) {
      const refresh = randomToken("1//fake-");

      state.refreshTokens.set(refresh, {
        clientId,
        email: user.email,
        scope,
      });
      body.refresh_token = refresh;
    }

    return body;
  }

  function handleJwtBearer(context: FakeRequest, form: URLSearchParams) {
    const { response } = context;
    const jwt = decodeJwt(form.get("assertion") ?? "");

    if (!jwt || jwt.header.alg !== "RS256") {
      oauthError(response, 400, "invalid_grant", "Invalid JWT.");
      return;
    }

    const claims = jwt.payload;
    const issuer = typeof claims.iss === "string" ? claims.iss : "";
    const keys = [
      ...(state.serviceAccountKeys.get(issuer) ?? []),
      ...(state.iamKeys.has(issuer) ? [state.iamKeys.get(issuer)!] : []),
    ];

    if (keys.length > 0 && !keys.some((key) => verifyJwt(jwt, key))) {
      oauthError(response, 400, "invalid_grant", "Invalid JWT Signature.");
      return;
    }

    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
      oauthError(
        response,
        400,
        "invalid_grant",
        "Invalid JWT: Token must be a short-lived token and in a reasonable timeframe.",
      );
      return;
    }

    const scopes =
      typeof claims.scope === "string"
        ? claims.scope.split(/\s+/).filter(Boolean)
        : [];

    if (scopes.length === 0) {
      oauthError(response, 400, "invalid_scope", "Invalid OAuth scope.");
      return;
    }

    let subject: string | null = null;

    if (typeof claims.sub === "string" && claims.sub !== issuer) {
      const user = findUser(state, claims.sub);

      if (!user || user.suspended) {
        oauthError(response, 400, "invalid_grant", "Invalid email or User ID");
        return;
      }

      subject = user.email;
    }

    sendJson(response, 200, {
      access_token: issueAccessToken({
        client: issuer,
        scopes,
        serviceAccount: issuer,
        user: subject,
      }),
      expires_in: ACCESS_TOKEN_SECONDS,
      token_type: "Bearer",
    });
  }

  function handleToken(context: FakeRequest) {
    const { request, response } = context;
    const form = new URLSearchParams(context.body.toString("utf8"));
    const grant = form.get("grant_type");

    if (grant === JWT_BEARER_GRANT) {
      handleJwtBearer(context, form);
      return;
    }

    const clientId = authenticateClient(request, form);

    if (!clientId) {
      oauthError(response, 401, "invalid_client", "Unauthorized");
      return;
    }

    if (grant === "authorization_code") {
      const code = state.codes.get(form.get("code") ?? "");

      state.codes.delete(form.get("code") ?? "");

      if (!code || code.expiresAt < Date.now() || code.clientId !== clientId) {
        oauthError(response, 400, "invalid_grant", "Bad Request");
        return;
      }

      if (form.get("redirect_uri") !== code.redirectUri) {
        oauthError(response, 400, "redirect_uri_mismatch", "Bad Request");
        return;
      }

      if (code.codeChallenge) {
        const verifier = form.get("code_verifier") ?? "";
        const expected =
          code.codeChallengeMethod === "S256"
            ? createHash("sha256").update(verifier).digest("base64url")
            : verifier;

        if (!verifier || expected !== code.codeChallenge) {
          oauthError(response, 400, "invalid_grant", "Invalid code verifier.");
          return;
        }
      }

      const user = state.users.get(code.email);

      if (!user) {
        oauthError(response, 400, "invalid_grant", "Account not found.");
        return;
      }

      sendJson(
        response,
        200,
        tokenResponse(
          user,
          clientId,
          code.scope,
          code.nonce,
          code.accessType === "offline",
        ),
      );
      return;
    }

    if (grant === "refresh_token") {
      const refresh = state.refreshTokens.get(form.get("refresh_token") ?? "");
      const user = refresh ? state.users.get(refresh.email) : undefined;

      if (!refresh || !user || refresh.clientId !== clientId) {
        oauthError(response, 400, "invalid_grant", "Bad Request");
        return;
      }

      sendJson(
        response,
        200,
        tokenResponse(user, clientId, refresh.scope, null, false),
      );
      return;
    }

    oauthError(
      response,
      400,
      "unsupported_grant_type",
      `Invalid grant_type: ${grant ?? ""}`,
    );
  }

  function handleUserinfo(context: FakeRequest) {
    const email = context.token?.user;
    const user = email ? state.users.get(email) : undefined;

    if (!context.token || context.token.serviceAccount || !user) {
      sendGoogleError(
        context.response,
        401,
        "authError",
        "Request had invalid authentication credentials.",
      );
      return;
    }

    sendJson(context.response, 200, {
      email: user.email,
      email_verified: user.emailVerified,
      family_name: user.familyName,
      given_name: user.givenName,
      ...(user.hd ? { hd: user.hd } : {}),
      name: `${user.givenName} ${user.familyName}`.trim(),
      ...(user.picture ? { picture: user.picture } : {}),
      sub: user.id,
    });
  }

  function handleSignJwt(context: FakeRequest, email: string) {
    if (
      !requireScope(
        context,
        (scope) =>
          scope === CLOUD_PLATFORM_SCOPE ||
          scope === "https://www.googleapis.com/auth/iam",
      )
    ) {
      return;
    }

    const input = readJsonBody(context.body);

    if (!input || typeof input.payload !== "string") {
      sendGoogleError(
        context.response,
        400,
        "badRequest",
        "Request contains an invalid argument.",
      );
      return;
    }

    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(input.payload) as Record<string, unknown>;
    } catch {
      sendGoogleError(
        context.response,
        400,
        "badRequest",
        "The payload is not JSON.",
      );
      return;
    }

    let key = state.iamKeys.get(email);

    if (!key) {
      key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      state.iamKeys.set(email, key);
    }

    const keyId = `iam-${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;

    sendJson(context.response, 200, {
      keyId,
      signedJwt: signJwt(payload, key, keyId),
    });
  }

  function handleControl(context: FakeRequest): boolean {
    const { method, path, response } = context;

    if (path === "/health" || path === "/__fake/health") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return true;
    }

    if (!path.startsWith("/__fake/")) {
      return false;
    }

    const input = readJsonBody(context.body) ?? {};

    if (path === "/__fake/state" && method === "GET") {
      sendJson(response, 200, {
        authorizations: state.authorizations,
        drives: Array.from(state.drives.values()),
        files: Array.from(state.files.values()).map(({ content, ...file }) => ({
          ...file,
          size: content.length,
        })),
        groups: Array.from(state.groups.values()),
        requests: state.requests,
        users: Array.from(state.users.values()),
      });
      return true;
    }

    if (method === "POST" && path === "/__fake/users") {
      sendJson(
        response,
        200,
        storeUser(state, input as unknown as FakeGoogleUser),
      );
      return true;
    }

    if (method === "POST" && path === "/__fake/groups") {
      sendJson(
        response,
        200,
        storeGroup(state, input as unknown as FakeGoogleGroup),
      );
      return true;
    }

    if (method === "POST" && path === "/__fake/drives") {
      sendJson(
        response,
        200,
        storeDrive(state, input as unknown as FakeSharedDrive),
      );
      return true;
    }

    if (method === "DELETE" && path === "/__fake/files") {
      state.files.clear();
      response.writeHead(204).end();
      return true;
    }

    sendJson(response, 404, { error: `No control endpoint ${method} ${path}` });
    return true;
  }

  function liveToken(request: IncomingMessage): FakeAccessToken | null {
    const header = request.headers.authorization ?? "";

    if (!header.startsWith("Bearer ")) {
      return null;
    }

    const token = state.accessTokens.get(header.slice(7).trim());

    return token && token.expiresAt > Date.now() ? token : null;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", baseUrl);
    const method = request.method ?? "GET";
    const context: FakeRequest = {
      baseUrl,
      body: await readBody(request),
      method,
      path: url.pathname,
      query: url.searchParams,
      request,
      response,
      state,
      token: liveToken(request),
    };

    state.requests.push({ method, path: url.pathname });

    if (state.requests.length > 500) {
      state.requests.splice(0, state.requests.length - 500);
    }

    if (handleControl(context)) {
      return;
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      sendJson(response, 200, discovery());
      return;
    }

    if (url.pathname === "/oauth2/v3/certs") {
      sendJson(response, 200, {
        keys: [
          {
            ...signing.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid,
            use: "sig",
          },
        ],
      });
      return;
    }

    if (url.pathname === "/o/oauth2/v2/auth" && method === "GET") {
      handleAuthorize(context);
      return;
    }

    if (url.pathname === "/o/oauth2/v2/auth/choose" && method === "POST") {
      handleChoose(context);
      return;
    }

    if (url.pathname === "/token" && method === "POST") {
      handleToken(context);
      return;
    }

    if (
      url.pathname === "/v1/userinfo" ||
      url.pathname === "/oauth2/v3/userinfo"
    ) {
      handleUserinfo(context);
      return;
    }

    if (url.pathname === "/revoke" && method === "POST") {
      const form = new URLSearchParams(context.body.toString("utf8"));

      state.accessTokens.delete(form.get("token") ?? "");
      state.refreshTokens.delete(form.get("token") ?? "");
      response.writeHead(200).end();
      return;
    }

    const signJwtPath =
      /^\/v1\/projects\/-\/serviceAccounts\/([^/]+):signJwt$/.exec(
        url.pathname,
      );

    if (signJwtPath && method === "POST") {
      handleSignJwt(context, decodeURIComponent(signJwtPath[1]!));
      return;
    }

    if (
      handleCloud(context) ||
      handleDirectory(context) ||
      handleDrive(context)
    ) {
      return;
    }

    sendGoogleError(
      response,
      404,
      "notFound",
      `The fake Google server has no ${method} ${url.pathname}.`,
    );
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("[fake google]", error);

      if (!response.headersSent) {
        sendGoogleError(
          response,
          500,
          "backendError",
          error instanceof Error ? error.message : "Fake Google failed.",
        );
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () =>
      resolve(),
    );
  });

  const address = server.address() as AddressInfo;

  baseUrl = `http://${options.host ?? "127.0.0.1"}:${String(address.port)}`;

  return {
    addDrive: (drive) => void storeDrive(state, drive),
    addGroup: (group) => void storeGroup(state, group),
    addUser: (user) => void storeUser(state, user),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    env: { GOOGLE_API_BASE_URL: baseUrl, GOOGLE_OAUTH_BASE_URL: baseUrl },
    files: () => Array.from(state.files.values()),
    issueAccessToken: (input) =>
      issueAccessToken({
        client: input.serviceAccount ?? FAKE_GOOGLE_CLIENT.id,
        scopes: input.scopes,
        serviceAccount: input.serviceAccount ?? null,
        user: input.user?.toLowerCase() ?? null,
      }),
    lastAuthorization: () => state.authorizations.at(-1) ?? null,
    state,
    url: baseUrl,
  };
}
