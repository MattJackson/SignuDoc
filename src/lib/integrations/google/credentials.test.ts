import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  createGoogleCredentials,
  GOOGLE_SCOPES,
  GoogleCredentialsError,
  parseServiceAccountKey,
  readGoogleProjectId,
  readGoogleProjectNumber,
  resetGoogleProjectNumberCache,
} from "./credentials.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const serviceAccountKey = JSON.stringify({
  client_email: "signer@example-project.iam.gserviceaccount.com",
  private_key: privateKey,
  token_uri: "https://oauth2.example.test/token",
});

type Call = { init?: RequestInit; url: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function decodeJwt(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");

  verifier.update(`${header}.${payload}`);

  return {
    claims: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    valid: verifier.verify(publicKey, Buffer.from(signature, "base64url")),
  };
}

test("is not configured off Google Cloud without a key", () => {
  assert.equal(createGoogleCredentials({ env: {} }), null);
});

test("reads a key given as JSON or as base64", () => {
  const fromJson = parseServiceAccountKey(serviceAccountKey);
  const fromBase64 = parseServiceAccountKey(
    Buffer.from(serviceAccountKey).toString("base64"),
  );

  assert.equal(fromJson.client_email, fromBase64.client_email);
  assert.throws(
    () => parseServiceAccountKey("{}"),
    (error) => error instanceof GoogleCredentialsError,
  );
});

test("signs an assertion with the key, with the subject, and caches the token", async () => {
  const calls: Call[] = [];
  let nowMs = 1_800_000_000_000;
  const credentials = createGoogleCredentials({
    env: { GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey },
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });

      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    },
    now: () => nowMs,
  });

  assert.ok(credentials);
  assert.equal(credentials.source, "service-account-key");

  const request = {
    scopes: [GOOGLE_SCOPES.directoryGroupReadonly],
    subject: "admin@example.com",
  };

  assert.equal(await credentials.getAccessToken(request), "token-1");
  assert.equal(await credentials.getAccessToken(request), "token-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.example.test/token");

  const body = new URLSearchParams(String(calls[0].init?.body));
  const { claims, valid } = decodeJwt(body.get("assertion") ?? "");

  assert.equal(valid, true);
  assert.equal(claims.sub, "admin@example.com");
  assert.equal(claims.scope, GOOGLE_SCOPES.directoryGroupReadonly);
  assert.equal(claims.aud, "https://oauth2.example.test/token");

  // Near its expiry, the token is fetched again.
  nowMs += 56 * 60 * 1000;
  await credentials.getAccessToken(request);
  assert.equal(calls.length, 2);
});

test("asks the metadata server for scoped tokens on Google Cloud", async () => {
  const calls: Call[] = [];
  const credentials = createGoogleCredentials({
    env: { K_SERVICE: "signudoc" },
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });

      return String(url).endsWith("/email")
        ? new Response("app@example-project.iam.gserviceaccount.com\n")
        : jsonResponse({ access_token: "metadata-token", expires_in: 3599 });
    },
  });

  assert.ok(credentials);
  assert.equal(credentials.source, "metadata");
  assert.equal(
    await credentials.getAccessToken({ scopes: [GOOGLE_SCOPES.drive] }),
    "metadata-token",
  );
  assert.match(calls[0].url, /\/token\?scopes=/);
  assert.equal(
    new Headers(calls[0].init?.headers).get("Metadata-Flavor"),
    "Google",
  );
  assert.equal(
    await credentials.getServiceAccountEmail(),
    "app@example-project.iam.gserviceaccount.com",
  );
});

test("acts as a Workspace user on Google Cloud through IAM signJwt", async () => {
  const calls: Call[] = [];
  const credentials = createGoogleCredentials({
    env: { K_SERVICE: "signudoc" },
    fetchImpl: async (url, init) => {
      const href = String(url);

      calls.push({ init, url: href });

      if (href.endsWith("/email")) {
        return new Response("app@example-project.iam.gserviceaccount.com");
      }

      if (href.includes("/token?scopes=")) {
        return jsonResponse({ access_token: "iam-token", expires_in: 3599 });
      }

      if (href.includes(":signJwt")) {
        return jsonResponse({ signedJwt: "signed.jwt.value" });
      }

      return jsonResponse({ access_token: "delegated", expires_in: 3599 });
    },
  });

  assert.ok(credentials);
  assert.equal(
    await credentials.getAccessToken({
      scopes: [GOOGLE_SCOPES.directoryUserReadonly],
      subject: "admin@example.com",
    }),
    "delegated",
  );

  const signCall = calls.find((call) => call.url.includes(":signJwt"));

  assert.ok(signCall);
  assert.equal(
    new Headers(signCall.init?.headers).get("authorization"),
    "Bearer iam-token",
  );

  const payload = JSON.parse(
    JSON.parse(String(signCall.init?.body)).payload as string,
  );

  assert.equal(payload.sub, "admin@example.com");
  assert.equal(payload.iss, "app@example-project.iam.gserviceaccount.com");
});

test("reports a failed exchange by status only", async () => {
  const credentials = createGoogleCredentials({
    env: { GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey },
    fetchImpl: async () => jsonResponse({ error: "invalid_grant" }, 400),
  });

  assert.ok(credentials);
  await assert.rejects(
    credentials.getAccessToken({ scopes: [GOOGLE_SCOPES.drive] }),
    (error) =>
      error instanceof GoogleCredentialsError &&
      error.message === "Google token exchange failed with 400.",
  );
});

test("a token request with no answer is given up on, and the next call asks again", async () => {
  let requests = 0;
  const credentials = createGoogleCredentials({
    env: { GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey },
    fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;

      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    }) as typeof fetch,
    timeoutMs: 20,
  });

  assert.ok(credentials);

  const request = { scopes: [GOOGLE_SCOPES.directoryGroupReadonly] };
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
  const timedOut = (error: unknown) =>
    error instanceof Error &&
    error.message !== "Still waiting after the deadline.";

  await assert.rejects(within(credentials.getAccessToken(request)), timedOut);
  await assert.rejects(within(credentials.getAccessToken(request)), timedOut);
  assert.equal(requests, 2);
});

function countingFetch(answer: () => Response | Promise<Response>) {
  const state = { calls: 0 };
  const fetchImpl = (() => {
    state.calls += 1;

    return Promise.resolve().then(answer);
  }) as unknown as typeof fetch;

  return { fetchImpl, state };
}

test("the project ID from the metadata server is read once and kept", async () => {
  resetGoogleProjectNumberCache();

  const { fetchImpl, state } = countingFetch(
    () => new Response("my-project-123"),
  );
  const env = { K_SERVICE: "signudoc" };

  assert.equal(await readGoogleProjectId({ env, fetchImpl }), "my-project-123");
  assert.equal(await readGoogleProjectId({ env, fetchImpl }), "my-project-123");
  assert.equal(state.calls, 1);
  resetGoogleProjectNumberCache();
});

test("a metadata lookup that failed is not repeated at once", async () => {
  resetGoogleProjectNumberCache();

  const env = { K_SERVICE: "signudoc" };
  const failing = countingFetch(() => {
    throw new Error("the metadata server hung");
  });

  assert.equal(
    await readGoogleProjectId({ env, fetchImpl: failing.fetchImpl }),
    null,
  );
  assert.equal(
    await readGoogleProjectId({ env, fetchImpl: failing.fetchImpl }),
    null,
  );
  assert.equal(failing.state.calls, 1);

  const refused = countingFetch(() => new Response("no", { status: 500 }));

  assert.equal(
    await readGoogleProjectNumber({ env, fetchImpl: refused.fetchImpl }),
    null,
  );
  assert.equal(
    await readGoogleProjectNumber({ env, fetchImpl: refused.fetchImpl }),
    null,
  );
  assert.equal(refused.state.calls, 1);
  resetGoogleProjectNumberCache();
});

test("GOOGLE_CLOUD_PROJECT is used without asking the metadata server", async () => {
  resetGoogleProjectNumberCache();

  const { fetchImpl, state } = countingFetch(() => new Response("other-id-1"));

  assert.equal(
    await readGoogleProjectId({
      env: { GOOGLE_CLOUD_PROJECT: "from-env-1" },
      fetchImpl,
    }),
    "from-env-1",
  );
  assert.equal(state.calls, 0);
});

// Which identity the app uses, in order: the key in the environment, the
// service account the environment says to impersonate, the key the setup
// stored, the account the setup stored for impersonation, the metadata
// server, or none.

const otherKey = JSON.stringify({
  client_email: "stored@example-project.iam.gserviceaccount.com",
  private_key: privateKey,
});
const gcloudLogin = JSON.stringify({
  client_id: "764086051850-gcloud.apps.googleusercontent.com",
  client_secret: "gcloud-secret",
  refresh_token: "1//refresh",
  type: "authorized_user",
});
const loginAt = (file: string) => (asked: string) =>
  asked === file ? gcloudLogin : null;
const DEFAULT_LOGIN =
  "/home/node/.config/gcloud/application_default_credentials.json";

test("the identity is chosen in order: environment, then what the setup stored, then the metadata server", async () => {
  const target = "app-workspace@example-project.iam.gserviceaccount.com";
  const cases: Array<{
    env: Record<string, string>;
    expect: { email?: string; source: string } | null;
    login?: boolean;
    stored?: { impersonate?: string; key?: string };
  }> = [
    { env: {}, expect: null },
    { env: { K_SERVICE: "signudoc" }, expect: { source: "metadata" } },
    {
      env: { K_SERVICE: "signudoc" },
      expect: {
        email: "stored@example-project.iam.gserviceaccount.com",
        source: "stored-key",
      },
      stored: { key: otherKey },
    },
    {
      env: {},
      expect: { email: target, source: "impersonation" },
      login: true,
      stored: { impersonate: target },
    },
    // Saved for impersonation, but no gcloud login is mounted yet.
    { env: {}, expect: null, stored: { impersonate: target } },
    {
      env: {},
      expect: {
        email: "stored@example-project.iam.gserviceaccount.com",
        source: "stored-key",
      },
      login: true,
      stored: { impersonate: target, key: otherKey },
    },
    {
      env: { GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: target },
      expect: { email: target, source: "impersonation" },
      login: true,
      stored: { key: otherKey },
    },
    {
      env: {
        GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: target,
        GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey,
      },
      expect: {
        email: "signer@example-project.iam.gserviceaccount.com",
        source: "service-account-key",
      },
      login: true,
      stored: { key: otherKey },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const credentials = createGoogleCredentials({
      env: { HOME: "/home/node", ...item.env },
      readFile: item.login ? loginAt(DEFAULT_LOGIN) : () => null,
      stored: item.stored ?? null,
    });

    if (!item.expect) {
      assert.equal(credentials, null, `case ${String(index)}`);
      continue;
    }

    assert.equal(
      credentials?.source,
      item.expect.source,
      `case ${String(index)}`,
    );

    if (item.expect.email) {
      assert.equal(
        await credentials?.getServiceAccountEmail(),
        item.expect.email,
        `case ${String(index)}`,
      );
    }
  }
});

test("impersonation set in the environment without a gcloud login says what is missing", () => {
  assert.throws(
    () =>
      createGoogleCredentials({
        env: {
          GOOGLE_IMPERSONATE_SERVICE_ACCOUNT:
            "app@example-project.iam.gserviceaccount.com",
          HOME: "/home/node",
        },
        readFile: () => null,
      }),
    /no gcloud application-default login is mounted/,
  );
});

test("a gcloud login made with --impersonate-service-account names the account itself", async () => {
  const file = "/secrets/adc.json";
  const credentials = createGoogleCredentials({
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: file,
      HOME: "/home/node",
    },
    readFile: (asked) =>
      asked === file
        ? JSON.stringify({
            service_account_impersonation_url:
              "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/app-workspace@example-project.iam.gserviceaccount.com:generateAccessToken",
            source_credentials: JSON.parse(gcloudLogin),
            type: "impersonated_service_account",
          })
        : null,
    stored: {
      impersonate: "app-workspace@example-project.iam.gserviceaccount.com",
    },
  });

  assert.equal(credentials?.source, "impersonation");
  assert.equal(
    await credentials?.getServiceAccountEmail(),
    "app-workspace@example-project.iam.gserviceaccount.com",
  );
});

test("impersonation refreshes the gcloud login, then asks IAM for the account's token or a signed assertion", async () => {
  const calls: Call[] = [];
  const credentials = createGoogleCredentials({
    env: {
      GOOGLE_IMPERSONATE_SERVICE_ACCOUNT:
        "app@example-project.iam.gserviceaccount.com",
      HOME: "/home/node",
    },
    fetchImpl: async (url, init) => {
      const href = String(url);

      calls.push({ init, url: href });

      if (href.endsWith(":generateAccessToken")) {
        return jsonResponse({
          accessToken: "impersonated",
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        });
      }

      if (href.endsWith(":signJwt")) {
        return jsonResponse({ signedJwt: "signed.jwt.value" });
      }

      const form = new URLSearchParams(String(init?.body));

      return jsonResponse({
        access_token:
          form.get("grant_type") === "refresh_token"
            ? "user-token"
            : "delegated",
        expires_in: 3599,
      });
    },
    readFile: loginAt(DEFAULT_LOGIN),
  });

  assert.ok(credentials);
  assert.equal(
    await credentials.getAccessToken({ scopes: [GOOGLE_SCOPES.drive] }),
    "impersonated",
  );

  const generate = calls.find((call) =>
    call.url.endsWith(":generateAccessToken"),
  );

  assert.equal(
    new Headers(generate?.init?.headers).get("authorization"),
    "Bearer user-token",
  );
  assert.deepEqual(JSON.parse(String(generate?.init?.body)).scope, [
    GOOGLE_SCOPES.drive,
  ]);
  assert.equal(
    await credentials.getAccessToken({
      scopes: [GOOGLE_SCOPES.directoryUserReadonly],
      subject: "admin@example.com",
    }),
    "delegated",
  );
  // The gcloud login was refreshed once and kept.
  assert.equal(
    calls.filter((call) =>
      String(call.init?.body).includes("grant_type=refresh_token"),
    ).length,
    1,
  );
});
