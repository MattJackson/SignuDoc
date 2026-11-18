import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import {
  buildAuthorizationUrl,
  createPkcePair,
  DriveAuthorizationError,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  openOAuthState,
  readIdTokenClaims,
  safeReturnPath,
  sealOAuthState,
} from "./drive-oauth.ts";
import {
  createDriveTokenStore,
  type DriveConnectionRepository,
  type StoredDriveConnection,
} from "./drive-tokens.ts";

// The Drive OAuth flow's pieces and the per-person token store, with a
// stand-in for Google's token endpoint and an in-memory table.

const env = { BETTER_AUTH_SECRET: "s".repeat(40) };
const client = {
  clientId: "client-1.apps.googleusercontent.com",
  clientSecret: "secret-1",
};

function memoryRepository(): DriveConnectionRepository & {
  rows: Map<string, StoredDriveConnection>;
} {
  const rows = new Map<string, StoredDriveConnection>();

  return {
    async delete(userId) {
      const row = rows.get(userId) ?? null;

      rows.delete(userId);

      return row;
    },
    async read(userId) {
      return rows.get(userId) ?? null;
    },
    rows,
    async write(connection) {
      rows.set(connection.userId, connection);
    },
  };
}

type TokenCall = { body: URLSearchParams; url: string };

function fakeGoogle(answer: (call: TokenCall) => Response) {
  const calls: TokenCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      body: new URLSearchParams(String(init?.body ?? "")),
      url: String(input),
    };

    calls.push(call);

    return answer(call);
  }) as typeof fetch;

  return { calls, fetchImpl };
}

function tokenResponse(accessToken: string, expiresIn = 3600) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: expiresIn,
      scope: "drive.file",
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

beforeEach(() => {
  globalThis.__signudocDriveAccessTokens = undefined;
});

test("the PKCE challenge is the SHA-256 of the verifier", () => {
  const { challenge, verifier } = createPkcePair();

  assert.ok(verifier.length >= 43);
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("the authorization link asks for drive.file only, offline, with PKCE", () => {
  const url = new URL(
    buildAuthorizationUrl({
      client,
      codeChallenge: "challenge-1",
      loginHint: "sam@example.com",
      redirectUri: "https://sign.example.com/api/google/drive/callback",
      state: "state-1",
    }),
  );

  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(
    url.searchParams.get("scope"),
    "openid email https://www.googleapis.com/auth/drive.file",
  );
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("login_hint"), "sam@example.com");
});

test("the state cookie opens only unchanged, with the same secret, and while fresh", () => {
  const value = {
    createdAt: 1_800_000_000,
    returnTo: "/envelopes/new",
    state: "state-1",
    userId: "user-1",
    verifier: "verifier-1",
  };
  const sealed = sealOAuthState(value, env);

  assert.deepEqual(openOAuthState(sealed, env, 1_800_000_100), value);
  assert.equal(
    openOAuthState(`${sealed.slice(0, -4)}AAAA`, env, 1_800_000_100),
    null,
  );
  assert.equal(
    openOAuthState(
      sealed,
      { BETTER_AUTH_SECRET: "t".repeat(40) },
      1_800_000_100,
    ),
    null,
  );
  assert.equal(openOAuthState(sealed, env, 1_800_000_000 + 11 * 60), null);
  assert.equal(openOAuthState(null, env), null);
});

test("only a path on this site is a place to return to", () => {
  assert.equal(
    safeReturnPath("/api/google/drive/open?state=%7B%7D"),
    "/api/google/drive/open?state=%7B%7D",
  );
  assert.equal(safeReturnPath("//evil.example"), "/envelopes/new");
  assert.equal(safeReturnPath("https://evil.example"), "/envelopes/new");
  assert.equal(safeReturnPath("/\\evil.example"), "/envelopes/new");
  assert.equal(safeReturnPath("/a b"), "/envelopes/new");
});

test("the ID token names the account, lowercased", () => {
  const payload = Buffer.from(
    JSON.stringify({
      email: "Sam@Example.com",
      email_verified: true,
      sub: "1234",
    }),
  ).toString("base64url");

  assert.deepEqual(readIdTokenClaims(`h.${payload}.s`), {
    email: "sam@example.com",
    sub: "1234",
  });
  assert.equal(readIdTokenClaims(null), null);
  assert.equal(readIdTokenClaims("not-a-jwt"), null);
});

test("a stored refresh token is encrypted, refreshed once, and the access token reused", async () => {
  const repository = memoryRepository();
  let now = 1_800_000_000_000;
  const google = fakeGoogle(() => tokenResponse("access-1"));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    now: () => now,
    repository,
  });

  await store.save({
    googleEmail: "sam@example.com",
    googleSubject: "1234",
    refreshToken: "refresh-1",
    scope: "drive.file",
    userId: "user-1",
  });

  assert.ok(!repository.rows.get("user-1")?.refreshToken.includes("refresh-1"));

  const [first, second] = await Promise.all([
    store.getAccessToken("user-1"),
    store.getAccessToken("user-1"),
  ]);

  assert.equal(first, "access-1");
  assert.equal(second, "access-1");
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0]?.url, GOOGLE_TOKEN_URL);
  assert.equal(google.calls[0]?.body.get("grant_type"), "refresh_token");
  assert.equal(google.calls[0]?.body.get("refresh_token"), "refresh-1");
  assert.equal(google.calls[0]?.body.get("client_id"), client.clientId);

  // Reused until shortly before it runs out, then refreshed again.
  now += 30 * 60 * 1000;
  await store.getAccessToken("user-1");
  assert.equal(google.calls.length, 1);

  now += 29 * 60 * 1000;
  await store.getAccessToken("user-1");
  assert.equal(google.calls.length, 2);
});

test("a refresh token Google no longer accepts is forgotten", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        headers: { "content-type": "application/json" },
        status: 400,
      }),
  );
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  });

  await store.save({
    googleEmail: "sam@example.com",
    googleSubject: "1234",
    refreshToken: "refresh-revoked",
    scope: "drive.file",
    userId: "user-2",
  });

  await assert.rejects(
    store.getAccessToken("user-2"),
    (error) =>
      error instanceof DriveAuthorizationError &&
      error.code === "not_connected",
  );
  assert.equal(repository.rows.has("user-2"), false);
});

test("a refresh that fails for a while keeps the connection", async () => {
  const outages: { name: string; fetchImpl: typeof fetch }[] = [
    {
      fetchImpl: fakeGoogle(
        () =>
          new Response(JSON.stringify({ error: "backend_error" }), {
            headers: { "content-type": "application/json" },
            status: 503,
          }),
      ).fetchImpl,
      name: "503",
    },
    {
      fetchImpl: fakeGoogle(
        () =>
          new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
            headers: { "content-type": "application/json" },
            status: 429,
          }),
      ).fetchImpl,
      name: "429",
    },
    {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      name: "network error",
    },
  ];

  for (const outage of outages) {
    const repository = memoryRepository();
    const store = createDriveTokenStore({
      env,
      fetchImpl: outage.fetchImpl,
      loadClient: async () => client,
      repository,
    });

    await store.save({
      googleEmail: "sam@example.com",
      googleSubject: "1234",
      refreshToken: "refresh-kept",
      scope: "drive.file",
      userId: "user-outage",
    });

    await assert.rejects(
      store.getAccessToken("user-outage"),
      (error) =>
        !(
          error instanceof DriveAuthorizationError &&
          error.code === "not_connected"
        ),
      outage.name,
    );
    assert.equal(repository.rows.has("user-outage"), true, outage.name);
  }
});

test("no connection, no token", async () => {
  const store = createDriveTokenStore({
    env,
    fetchImpl: fakeGoogle(() => tokenResponse("never")).fetchImpl,
    loadClient: async () => client,
    repository: memoryRepository(),
  });

  await assert.rejects(
    store.getAccessToken("nobody"),
    (error) =>
      error instanceof DriveAuthorizationError &&
      error.code === "not_connected",
  );
  assert.equal(await store.getConnection("nobody"), null);
});

test("disconnecting revokes the token at Google and forgets it", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(() => new Response(null, { status: 200 }));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  });

  await store.save({
    googleEmail: "sam@example.com",
    googleSubject: "1234",
    refreshToken: "refresh-3",
    scope: "drive.file",
    userId: "user-3",
  });

  assert.equal(await store.disconnect("user-3"), true);
  assert.equal(repository.rows.has("user-3"), false);
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0]?.url, GOOGLE_REVOKE_URL);
  assert.equal(google.calls[0]?.body.get("token"), "refresh-3");
  assert.equal(await store.disconnect("user-3"), false);
});

test("connecting again revokes the token it replaces", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(() => new Response(null, { status: 200 }));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  });
  const connection = {
    googleEmail: "sam@example.com",
    googleSubject: "1234",
    scope: "drive.file",
    userId: "user-4",
  };

  await store.save({ ...connection, refreshToken: "refresh-old" });
  await store.save({ ...connection, refreshToken: "refresh-new" });

  assert.deepEqual(
    google.calls.map((call) => call.body.get("token")),
    ["refresh-old"],
  );
});
