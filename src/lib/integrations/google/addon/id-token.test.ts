import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { resolveWorkspaceDomains } from "../../../auth/sso.ts";
import type { AddonConfig } from "./config.ts";
import {
  createJwksCache,
  IdTokenError,
  verifyGoogleIdToken,
  type IdTokenProblem,
} from "./id-token.ts";
import {
  AddonRequestError,
  authenticateAddonRequest,
} from "./verify-request.ts";

// Google's ID tokens, checked against a key set made here: a good token,
// and one wrong in each way that matters.

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ENDPOINT = "https://sign.example.test/api/google/addon/gmail-message";
const SERVICE_ACCOUNT =
  "service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const CLIENT_ID = "117000000000000000001";

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

function sign(
  claims: Record<string, unknown>,
  {
    alg = "RS256",
    key = google.privateKey,
    kid = "key-1",
  }: { alg?: string; key?: typeof google.privateKey; kid?: string } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");

  signer.update(`${header}.${payload}`);

  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}

function systemClaims(overrides: Record<string, unknown> = {}) {
  return {
    aud: ENDPOINT,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: NOW + 3600,
    iat: NOW - 10,
    iss: "https://accounts.google.com",
    sub: "1000",
    ...overrides,
  };
}

function userClaims(overrides: Record<string, unknown> = {}) {
  return {
    aud: CLIENT_ID,
    email: "Sam@Example.com",
    email_verified: true,
    exp: NOW + 3600,
    hd: "example.com",
    iat: NOW - 10,
    iss: "accounts.google.com",
    name: "Sam Sender",
    sub: "2000",
    ...overrides,
  };
}

function keySet() {
  let requests = 0;
  const jwk = google.publicKey.export({ format: "jwk" });
  const jwks = createJwksCache({
    fetchImpl: (async () => {
      requests += 1;

      return new Response(
        JSON.stringify({
          keys: [{ ...jwk, alg: "RS256", kid: "key-1", use: "sig" }],
        }),
        { headers: { "cache-control": "public, max-age=600" } },
      );
    }) as typeof fetch,
    now: () => NOW_MS,
  });

  return { jwks, requests: () => requests };
}

async function problemOf(token: string, audiences = [ENDPOINT]) {
  try {
    await verifyGoogleIdToken({
      audiences,
      jwks: keySet().jwks,
      now: () => NOW_MS,
      token,
    });
  } catch (error) {
    assert.ok(error instanceof IdTokenError);
    return error.problem;
  }

  return "ok" as const;
}

test("a good token's claims come back, and the keys are read once", async () => {
  const { jwks, requests } = keySet();
  const claims = await verifyGoogleIdToken({
    audiences: [ENDPOINT],
    jwks,
    now: () => NOW_MS,
    token: sign(systemClaims()),
  });

  assert.equal(claims.email, SERVICE_ACCOUNT);
  await verifyGoogleIdToken({
    audiences: [ENDPOINT],
    jwks,
    now: () => NOW_MS,
    token: sign(systemClaims()),
  });
  assert.equal(requests(), 1);
});

test("each wrong token is refused, saying why", async () => {
  const cases: [string, IdTokenProblem][] = [
    [sign(systemClaims({ iss: "https://evil.example" })), "wrong_issuer"],
    [
      sign(systemClaims({ aud: "https://elsewhere.example/hook" })),
      "wrong_audience",
    ],
    [sign(systemClaims({ exp: NOW - 3600 })), "expired"],
    [sign(systemClaims({ iat: NOW + 3600 })), "not_yet_valid"],
    [sign(systemClaims(), { key: stranger.privateKey }), "bad_signature"],
    [sign(systemClaims(), { kid: "key-unknown" }), "unknown_key"],
    [sign(systemClaims(), { alg: "HS256" }), "unsupported_algorithm"],
    ["not-a-jwt", "malformed"],
    ["", "malformed"],
  ];

  for (const [token, problem] of cases) {
    assert.equal(await problemOf(token), problem, problem);
  }
});

test("a token whose claims were changed after signing is refused", async () => {
  const [header, , signature] = sign(systemClaims()).split(".");
  const forged = Buffer.from(
    JSON.stringify(systemClaims({ email: "attacker@example.com" })),
  ).toString("base64url");

  assert.equal(
    await problemOf(`${header}.${forged}.${signature}`),
    "bad_signature",
  );
});

test("a key Google added since is fetched again, but not on every request", async () => {
  let nowMs = NOW_MS;
  let served: object[] = [];
  let requests = 0;
  const jwks = createJwksCache({
    fetchImpl: (async () => {
      requests += 1;
      return new Response(JSON.stringify({ keys: served }));
    }) as typeof fetch,
    now: () => nowMs,
  });

  assert.equal(await jwks.getKey("key-1"), null);
  assert.equal(requests, 1);
  // Asked again at once: not fetched again.
  assert.equal(await jwks.getKey("key-1"), null);
  assert.equal(requests, 1);

  served = [{ ...google.publicKey.export({ format: "jwk" }), kid: "key-1" }];
  nowMs += 61_000;
  assert.ok(await jwks.getKey("key-1"));
  assert.equal(requests, 2);
});

const config: AddonConfig = {
  extraAudiences: [],
  oauthClientId: CLIENT_ID,
  oauthClientIdSource: "settings",
  ready: true,
  serviceAccountEmail: SERVICE_ACCOUNT,
  serviceAccountSource: "settings",
};

async function authenticate(
  overrides: Partial<Parameters<typeof authenticateAddonRequest>[0]> = {},
) {
  return authenticateAddonRequest({
    audiences: [ENDPOINT],
    bearerToken: sign(systemClaims()),
    config,
    jwks: keySet().jwks,
    now: () => NOW_MS,
    systemIdToken: "",
    userIdToken: sign(userClaims()),
    workspaceDomains: ["example.com"],
    ...overrides,
  });
}

async function rejection(
  overrides: Partial<Parameters<typeof authenticateAddonRequest>[0]>,
) {
  try {
    await authenticate(overrides);
  } catch (error) {
    assert.ok(error instanceof AddonRequestError);
    return error.problem;
  }

  return "ok" as const;
}

test("a request from the add-on names its user, by verified address", async () => {
  const caller = await authenticate();

  assert.deepEqual(caller, {
    email: "sam@example.com",
    hostedDomain: "example.com",
    name: "Sam Sender",
    subject: "2000",
  });
  // The event's copy of the system token does when the header is missing.
  assert.equal(
    (
      await authenticate({
        bearerToken: "",
        systemIdToken: sign(systemClaims()),
      })
    ).email,
    "sam@example.com",
  );
});

test("a request is refused unless the add-on's service account sent it", async () => {
  assert.equal(
    await rejection({
      bearerToken: sign(
        systemClaims({ email: "other@project.iam.gserviceaccount.com" }),
      ),
    }),
    "not_from_google",
  );
  assert.equal(
    await rejection({
      bearerToken: sign(systemClaims({ email_verified: false })),
    }),
    "not_from_google",
  );
  assert.equal(
    await rejection({
      bearerToken: sign(
        systemClaims({ aud: "https://sign.example.test/other" }),
      ),
    }),
    "not_from_google",
  );
  assert.equal(await rejection({ bearerToken: "" }), "not_from_google");
  assert.equal(
    await rejection({
      config: { ...config, oauthClientId: null, ready: false },
    }),
    "not_configured",
  );
});

test("the user must be a verified account in the Workspace, for this client", async () => {
  assert.equal(
    await rejection({ userIdToken: sign(userClaims({ aud: "someone-else" })) }),
    "no_user",
  );
  assert.equal(
    await rejection({
      userIdToken: sign(userClaims({ email_verified: false })),
    }),
    "no_user",
  );
  assert.equal(
    await rejection({ userIdToken: sign(userClaims({ hd: undefined })) }),
    "outside_workspace",
  );
  assert.equal(
    await rejection({ userIdToken: sign(userClaims({ hd: "other.example" })) }),
    "outside_workspace",
  );
  // With no domains known, any Workspace account passes, as for sign-in.
  assert.equal(
    await rejection({
      userIdToken: sign(userClaims({ hd: "other.example" })),
      workspaceDomains: [],
    }),
    "ok",
  );
});

test("a configured but invalid Workspace domain list lets no add-on caller in", async () => {
  const invalid = resolveWorkspaceDomains({
    env: { GOOGLE_WORKSPACE_DOMAINS: "acme" },
    signupDomains: [],
    stored: null,
  });

  assert.equal(
    await rejection({
      userIdToken: sign(userClaims({ hd: "other.example" })),
      workspaceDomains: invalid,
    }),
    "outside_workspace",
  );
});

test("a failure reading Google's keys is not reported as a forged request", async () => {
  const failures: (typeof fetch)[] = [
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    (async () => new Response("unavailable", { status: 500 })) as typeof fetch,
    (async () => new Response("not json", { status: 200 })) as typeof fetch,
  ];

  for (const fetchImpl of failures) {
    await assert.rejects(
      authenticate({ jwks: createJwksCache({ fetchImpl, now: () => NOW_MS }) }),
      (error) =>
        error instanceof IdTokenError && error.problem === "keys_unavailable",
    );
  }
});

test("a key request with no answer is given up on, and the next call asks again", async () => {
  let requests = 0;
  const jwks = createJwksCache({
    fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;

      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    }) as typeof fetch,
    now: () => NOW_MS,
    timeoutMs: 20,
  });
  const within = <T>(promise: Promise<T>) => {
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
  };
  const unavailable = (error: unknown) =>
    error instanceof IdTokenError && error.problem === "keys_unavailable";

  await assert.rejects(within(jwks.getKey("key-1")), unavailable);
  await assert.rejects(within(jwks.getKey("key-1")), unavailable);
  assert.equal(requests, 2);
});
