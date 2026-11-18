import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  createGoogleCredentials,
  GOOGLE_SCOPES,
  GoogleCredentialsError,
  parseServiceAccountKey,
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
  } as Parameters<typeof createGoogleCredentials>[0]);

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
