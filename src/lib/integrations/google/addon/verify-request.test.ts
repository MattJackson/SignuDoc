import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import type { AddonConfig } from "./config.ts";
import { IdTokenError, type JwksCache } from "./id-token.ts";
import {
  AddonRequestError,
  authenticateAddonRequest,
} from "./verify-request.ts";

// What becomes of a failure to reach Google's signing keys: it is the
// server's trouble, not a bad request, so it must not look like one.

const NOW_MS = 1_800_000_000_000;
const ENDPOINT = "https://sign.example.test/api/google/addon/gmail-message";
const CONFIG: AddonConfig = {
  extraAudiences: [],
  oauthClientId: "117000000000000000001",
  oauthClientIdSource: "env",
  ready: true,
  serviceAccountEmail: "service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  serviceAccountSource: "env",
};
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

function token(key = google.privateKey): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: ENDPOINT,
      exp: NOW_MS / 1000 + 3600,
      iat: NOW_MS / 1000 - 10,
      iss: "https://accounts.google.com",
      sub: "1000",
    }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");

  signer.update(`${header}.${payload}`);

  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}

function authenticate(jwks: JwksCache, systemToken = token()) {
  return authenticateAddonRequest({
    audiences: [ENDPOINT],
    bearerToken: systemToken,
    config: CONFIG,
    jwks,
    now: () => NOW_MS,
    systemIdToken: "",
    userIdToken: systemToken,
    workspaceDomains: ["example.com"],
  });
}

test("keys that cannot be fetched are not answered as a bad request", async () => {
  const unavailable: JwksCache = {
    getKey: async () => {
      throw new IdTokenError(
        "keys_unavailable",
        "Google's signing keys could not be fetched.",
      );
    },
  };

  await assert.rejects(authenticate(unavailable), (error: unknown) => {
    assert.ok(!(error instanceof AddonRequestError));
    assert.ok(error instanceof IdTokenError);
    assert.equal(error.problem, "keys_unavailable");

    return true;
  });
});

test("a network failure fetching the keys is not answered as a bad request", async () => {
  const offline: JwksCache = {
    getKey: async () => {
      throw new TypeError("fetch failed");
    },
  };

  await assert.rejects(authenticate(offline), (error: unknown) => {
    assert.ok(!(error instanceof AddonRequestError));
    assert.ok(error instanceof TypeError);

    return true;
  });
});

test("a token with a bad signature is still not from Google", async () => {
  const jwks: JwksCache = { getKey: async () => stranger.publicKey };

  await assert.rejects(authenticate(jwks), (error: unknown) => {
    assert.ok(error instanceof AddonRequestError);
    assert.equal(error.problem, "not_from_google");

    return true;
  });
});
