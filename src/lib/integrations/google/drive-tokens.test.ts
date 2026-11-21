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
  refreshAccessToken,
  revokeToken,
  safeReturnPath,
  sealOAuthState,
} from "./drive-oauth.ts";
import type { DbPool } from "../../db/connection.ts";
import {
  connectDrive,
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
  (globalThis as Record<string, unknown>).__signudocDriveRefreshes = undefined;
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

test("connecting again never revokes inside save: the old token shares the new grant", async () => {
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

  assert.equal(
    await store.save({ ...connection, refreshToken: "refresh-old" }),
    null,
  );
  assert.deepEqual(
    await store.save({ ...connection, refreshToken: "refresh-new" }),
    { googleSubject: "1234", refreshToken: "refresh-old" },
  );
  await store.save({
    ...connection,
    googleSubject: "9999",
    refreshToken: "refresh-newer",
  });

  assert.deepEqual(google.calls, []);
});

async function storedRow(refreshToken: string, googleSubject: string) {
  const repository = memoryRepository();

  await createDriveTokenStore({ env, repository }).save({
    googleEmail: "sam@example.com",
    googleSubject,
    refreshToken,
    scope: "drive.file",
    userId: "user-6",
  });

  return repository.rows.get("user-6")!;
}

// A pool that answers only what connectDrive asks, and notes BEGIN, COMMIT
// and ROLLBACK.
function fakePool(
  existing: StoredDriveConnection,
  events: string[],
  failAudit: boolean,
) {
  const connection = {
    async query(text: string) {
      const sql = text.trim();

      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        events.push(sql.split(/\s/)[0]!.toUpperCase());

        return { rowCount: 0, rows: [] };
      }

      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM google_drive_tokens")
      ) {
        return { rowCount: 1, rows: [existing] };
      }

      if (failAudit && sql.includes("INSERT INTO system_audit_events")) {
        throw new Error("The audit insert failed.");
      }

      return { rowCount: 0, rows: [] };
    },
    release() {},
  };

  return { connect: async () => connection } as unknown as DbPool;
}

async function connectAgain(subject: string, failAudit = false) {
  const events: string[] = [];
  const realFetch = globalThis.fetch;
  const database = fakePool(
    await storedRow("refresh-old", "1234"),
    events,
    failAudit,
  );

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    events.push(
      String(input) === GOOGLE_REVOKE_URL
        ? `revoke ${new URLSearchParams(String(init?.body)).get("token") ?? ""}`
        : `other ${String(input)}`,
    );

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const result = await connectDrive(
      {
        googleEmail: "sam@example.com",
        googleSubject: subject,
        refreshToken: "refresh-new",
        scope: "drive.file",
      },
      { email: "sam@example.com", id: "user-6" },
      { database, env },
    ).then(
      () => "connected",
      () => "failed",
    );

    return { events, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("reconnecting the same Google account does not revoke the old token", async () => {
  const { events, result } = await connectAgain("1234");

  assert.equal(result, "connected");
  assert.ok(events.includes("COMMIT"));
  assert.deepEqual(
    events.filter((event) => event.startsWith("revoke")),
    [],
  );
});

test("connecting a different Google account revokes the old token only after the commit", async () => {
  const { events, result } = await connectAgain("9999");

  assert.equal(result, "connected");
  assert.deepEqual(
    events.filter((event) => event === "COMMIT" || event.startsWith("revoke")),
    ["COMMIT", "revoke refresh-old"],
  );
});

test("a connection that does not commit revokes nothing", async () => {
  const { events, result } = await connectAgain("9999", true);

  assert.equal(result, "failed");
  assert.ok(events.includes("ROLLBACK"));
  assert.deepEqual(
    events.filter((event) => event.startsWith("revoke")),
    [],
  );
});

test("a connection saved while Google was answering invalid_grant is kept", async () => {
  const repository = memoryRepository();
  const fresh = await storedRow("refresh-new", "1234");
  const google = fakeGoogle(() => {
    // The person reconnects while the old token is being tried.
    repository.rows.set("user-6", fresh);

    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      headers: { "content-type": "application/json" },
      status: 400,
    });
  });
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  });

  repository.rows.set("user-6", await storedRow("refresh-old", "1234"));

  await assert.rejects(
    store.getAccessToken("user-6"),
    (error) =>
      error instanceof DriveAuthorizationError &&
      error.code === "not_connected",
  );
  assert.equal(repository.rows.get("user-6"), fresh);
});

test("an access token cached here is not served once the connection is gone or replaced", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle((call) =>
    tokenResponse(`access-for-${call.body.get("refresh_token") ?? ""}`),
  );
  const store = createDriveTokenStore({
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  });

  // Made first: saving a connection clears the cache.
  const oldRow = await storedRow("refresh-old", "1234");
  const newRow = await storedRow("refresh-new", "1234");

  repository.rows.set("user-6", oldRow);
  assert.equal(await store.getAccessToken("user-6"), "access-for-refresh-old");

  // Another instance replaced the connection.
  repository.rows.set("user-6", newRow);
  assert.equal(await store.getAccessToken("user-6"), "access-for-refresh-new");

  // Another instance disconnected it.
  repository.rows.delete("user-6");
  await assert.rejects(
    store.getAccessToken("user-6"),
    (error) =>
      error instanceof DriveAuthorizationError &&
      error.code === "not_connected",
  );
});

test("two stores asking for one person's token at once make one request", async () => {
  const repository = memoryRepository();
  const google = fakeGoogle(() => tokenResponse("access-1"));
  const options = {
    env,
    fetchImpl: google.fetchImpl,
    loadClient: async () => client,
    repository,
  };

  repository.rows.set("user-6", await storedRow("refresh-old", "1234"));

  const tokens = await Promise.all([
    createDriveTokenStore(options).getAccessToken("user-6"),
    createDriveTokenStore(options).getAccessToken("user-6"),
  ]);

  assert.deepEqual(tokens, ["access-1", "access-1"]);
  assert.equal(google.calls.length, 1);
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
    (error) =>
      error instanceof DriveAuthorizationError && error.code === "failed",
  );
});

test("a revoke request with no answer is given up on and reports false", async () => {
  assert.equal(
    await within(revokeToken("refresh-1", hangingFetch(), 20)),
    false,
  );
});
