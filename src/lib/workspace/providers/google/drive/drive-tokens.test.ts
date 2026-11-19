import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import type {
  FileConnectionRepository,
  StoredFileConnection,
} from "../../../file-connections.ts";
import { FilesConnectionError } from "../../../types.ts";
import { createGoogleFiles } from "./drive-files.ts";
import {
  buildAuthorizationUrl,
  createPkcePair,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  readDriveOAuthClient,
  readIdTokenClaims,
  refreshAccessToken,
  revokeToken,
} from "./drive-oauth.ts";
import { createDriveTokenStore } from "./drive-tokens.ts";

// The Drive OAuth flow's pieces and the per-person token store, with a
// stand-in for Google's token endpoint and an in-memory table.

const env = { BETTER_AUTH_SECRET: "s".repeat(40) };
const client = {
  clientId: "client-1.apps.googleusercontent.com",
  clientSecret: "secret-1",
};

function memoryRepository(): FileConnectionRepository & {
  rows: Map<string, StoredFileConnection>;
} {
  const rows = new Map<string, StoredFileConnection>();

  return {
    async delete(userId: string, expectedRefreshToken?: string) {
      const row = rows.get(userId) ?? null;

      if (
        row &&
        expectedRefreshToken !== undefined &&
        row.refreshToken !== expectedRefreshToken
      ) {
        return null;
      }

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

function tokenResponse(accessToken: string, extra: object = {}) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: 3600,
      scope: "drive.file",
      ...extra,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

const isNotConnected = (error: unknown) =>
  error instanceof FilesConnectionError && error.code === "not_connected";

beforeEach(() => {
  globalThis.__signudocDriveAccessTokens = undefined;
  globalThis.__signudocDriveRefreshes = undefined;
});

test("the OAuth client is its own, or Google sign-in's", () => {
  assert.deepEqual(
    readDriveOAuthClient({
      GOOGLE_OAUTH_CLIENT_ID: "own",
      GOOGLE_OAUTH_CLIENT_SECRET: "own-secret",
      SSO_CLIENT_ID: "sso",
      SSO_CLIENT_SECRET: "sso-secret",
      SSO_ISSUER: "https://accounts.google.com",
    }),
    { clientId: "own", clientSecret: "own-secret" },
  );
  assert.deepEqual(
    readDriveOAuthClient({
      SSO_CLIENT_ID: "sso",
      SSO_CLIENT_SECRET: "sso-secret",
      SSO_ISSUER: "https://accounts.google.com/",
    }),
    { clientId: "sso", clientSecret: "sso-secret" },
  );
  // Sign-in with another provider is not a Google client.
  assert.equal(
    readDriveOAuthClient({
      SSO_CLIENT_ID: "sso",
      SSO_CLIENT_SECRET: "sso-secret",
      SSO_ISSUER: "https://login.microsoftonline.com/tenant/v2.0",
    }),
    null,
  );
  assert.equal(readDriveOAuthClient({}), null);
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
      env: {},
      loginHint: "sam@example.com",
      redirectUri: "https://sign.example.com/api/workspace/files/callback",
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

const connection = {
  accountEmail: "sam@example.com",
  accountId: "1234",
  scope: "drive.file",
};

test("a stored refresh token is encrypted, refreshed once, and the access token reused", async () => {
  const repository = memoryRepository();
  let now = 1_800_000_000_000;
  const google = fakeGoogle(() => tokenResponse("access-1"));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: () => client,
    now: () => now,
    repository,
  });

  await store.save({
    ...connection,
    refreshToken: "refresh-1",
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

test("a token sealed for one person cannot be read as another's", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(() => tokenResponse("access-1"));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: () => client,
    repository,
  });

  await store.save({
    ...connection,
    refreshToken: "refresh-1",
    userId: "user-a",
  });
  repository.rows.set("user-b", {
    ...repository.rows.get("user-a")!,
    userId: "user-b",
  });

  await assert.rejects(store.getAccessToken("user-b"), isNotConnected);
  assert.equal(google.calls.length, 0);
  assert.equal(repository.rows.has("user-b"), false);
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
    loadClient: () => client,
    repository,
  });

  await store.save({
    ...connection,
    refreshToken: "refresh-revoked",
    userId: "user-2",
  });

  await assert.rejects(store.getAccessToken("user-2"), isNotConnected);
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
      loadClient: () => client,
      repository,
    });

    await store.save({
      ...connection,
      refreshToken: "refresh-kept",
      userId: "user-outage",
    });

    await assert.rejects(
      store.getAccessToken("user-outage"),
      (error) =>
        error instanceof FilesConnectionError && error.code === "failed",
      outage.name,
    );
    assert.equal(repository.rows.has("user-outage"), true, outage.name);
  }
});

test("no connection, no token", async () => {
  const store = createDriveTokenStore({
    env,
    fetchImpl: fakeGoogle(() => tokenResponse("never")).fetchImpl,
    loadClient: () => client,
    repository: memoryRepository(),
  });

  await assert.rejects(store.getAccessToken("nobody"), isNotConnected);
  assert.equal(await store.getConnection("nobody"), null);
});

test("disconnecting revokes the token at Google and forgets it", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(() => new Response(null, { status: 200 }));
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: () => client,
    repository,
  });

  await store.save({
    ...connection,
    refreshToken: "refresh-3",
    userId: "user-3",
  });

  assert.equal(await store.disconnect("user-3"), true);
  assert.equal(repository.rows.has("user-3"), false);
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0]?.url, GOOGLE_REVOKE_URL);
  assert.equal(google.calls[0]?.body.get("token"), "refresh-3");
  assert.equal(await store.disconnect("user-3"), false);
});

test("an access token cached here is not served once the connection is gone or replaced", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle((call) =>
    tokenResponse(`access-for-${call.body.get("refresh_token") ?? ""}`),
  );
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: () => client,
    repository,
  });

  await store.save({ ...connection, refreshToken: "refresh-old", userId: "u" });
  const oldRow = repository.rows.get("u")!;

  await store.save({ ...connection, refreshToken: "refresh-new", userId: "u" });
  const newRow = repository.rows.get("u")!;

  repository.rows.set("u", oldRow);
  assert.equal(await store.getAccessToken("u"), "access-for-refresh-old");

  // Another instance replaced the connection.
  repository.rows.set("u", newRow);
  assert.equal(await store.getAccessToken("u"), "access-for-refresh-new");

  // Another instance disconnected it.
  repository.rows.delete("u");
  await assert.rejects(store.getAccessToken("u"), isNotConnected);
});

function idToken(email: string, sub: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, email_verified: true, sub }),
  ).toString("base64url");

  return `h.${payload}.s`;
}

/** Connects twice through finishConnect and notes what was revoked. */
async function connectTwice(secondSubject: string, secondEmail?: string) {
  const repository = memoryRepository();
  let exchange = 0;
  const revoked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));

    if (String(input) === GOOGLE_REVOKE_URL) {
      revoked.push(body.get("token") ?? "");

      return new Response(null, { status: 200 });
    }

    exchange += 1;

    return tokenResponse(`access-${String(exchange)}`, {
      id_token:
        exchange === 1
          ? idToken("sam@example.com", "1234")
          : idToken(secondEmail ?? "sam@example.com", secondSubject),
      refresh_token: `refresh-${String(exchange)}`,
      scope: "openid email https://www.googleapis.com/auth/drive.file",
    });
  }) as typeof fetch;
  const files = createGoogleFiles({
    credentials: () => null,
    env: {
      ...env,
      GOOGLE_OAUTH_CLIENT_ID: client.clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: client.clientSecret,
    },
    fetchImpl,
    stored: null,
    tokens: createDriveTokenStore({
      env,
      fetchImpl,
      loadClient: () => client,
      repository,
    }),
  });
  const finish = () =>
    files.finishConnect({
      email: "Sam@Example.com",
      params: new URLSearchParams({ code: "code-1" }),
      redirectUri: "https://sign.example.com/api/workspace/files/callback",
      secret: "verifier",
      userId: "user-6",
    });

  const first = await finish();
  const second = await finish().catch((error: unknown) => error);

  return { first, repository, revoked, second };
}

test("reconnecting the same Google account does not revoke the old token", async () => {
  const { first, revoked } = await connectTwice("1234");

  assert.equal(first.account, "sam@example.com");
  assert.deepEqual(revoked, []);
});

test("connecting a different Google account revokes the old token", async () => {
  const { revoked } = await connectTwice("9999");

  assert.deepEqual(revoked, ["refresh-1"]);
});

test("an account that is not the person's own is refused and revoked", async () => {
  const { repository, revoked, second } = await connectTwice(
    "5555",
    "someone@else.example",
  );

  assert.ok(
    second instanceof FilesConnectionError && second.code === "wrong_account",
  );
  assert.deepEqual(revoked, ["refresh-2"]);
  // The first connection stays.
  assert.equal(repository.rows.get("user-6")?.accountId, "1234");
});

// A fetch that answers only when its signal aborts.
function hangingFetch() {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
}

function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Still waiting after the deadline."));
      }, 2000);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

test("a token request with no answer ends as a could-not-be-reached error", async () => {
  await assert.rejects(
    within(
      refreshAccessToken({
        client,
        fetchImpl: hangingFetch(),
        refreshToken: "refresh-1",
        timeoutMs: 20,
      }),
    ),
    (error) => error instanceof FilesConnectionError && error.code === "failed",
  );
});

test("a revoke request with no answer is given up on and reports false", async () => {
  assert.equal(
    await within(
      revokeToken("refresh-1", { fetchImpl: hangingFetch(), timeoutMs: 20 }),
    ),
    false,
  );
});
