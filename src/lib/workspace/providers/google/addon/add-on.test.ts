import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";

import type { AddInAccountLookup } from "../../../add-in-support.ts";
import { createGoogleAddIn } from "./add-on.ts";
import { notify } from "./cards.ts";
import type { JwksCache } from "./id-token.ts";

// The add-on's request handling, end to end but for Google's keys, the
// account lookup and the action itself: what a request must carry before
// anything is read, and what each kind of caller gets back.

const SITE = "https://sign.example.test";
const SERVICE_ACCOUNT =
  "service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const CLIENT_ID = "117000000000000000001";
const ENV = {
  APP_URL: SITE,
  GOOGLE_ADDON_CLIENT_ID: CLIENT_ID,
  GOOGLE_ADDON_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
};

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: JwksCache = {
  getKey: async (kid) => (kid === "key-1" ? google.publicKey : null),
};

function sign(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");

  signer.update(`${header}.${payload}`);

  return `${header}.${payload}.${signer.sign(google.privateKey).toString("base64url")}`;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function systemToken(action: string, overrides: Record<string, unknown> = {}) {
  return sign({
    aud: `${SITE}/api/workspace/add-in/${action}`,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: now() + 3600,
    iat: now() - 10,
    iss: "https://accounts.google.com",
    sub: "1000",
    ...overrides,
  });
}

function userToken(overrides: Record<string, unknown> = {}) {
  return sign({
    aud: CLIENT_ID,
    email: "sam@example.com",
    email_verified: true,
    exp: now() + 3600,
    hd: "example.com",
    iat: now() - 10,
    iss: "https://accounts.google.com",
    name: "Sam Sender",
    sub: "2000",
    ...overrides,
  });
}

function request(
  action: string,
  {
    system = systemToken(action),
    user = userToken(),
  }: { system?: string; user?: string } = {},
) {
  return new Request(`${SITE}/api/workspace/add-in/${action}`, {
    body: JSON.stringify({
      authorizationEventObject: { userIdToken: user },
      commonEventObject: { hostApp: "GMAIL" },
    }),
    headers: {
      authorization: `Bearer ${system}`,
      "content-type": "application/json",
      // Each request from its own address, so failures in one test do not
      // count against another.
      "x-forwarded-for": `10.0.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`,
    },
    method: "POST",
  });
}

function addIn(lookup: AddInAccountLookup = { kind: "no_account" }) {
  const ran: string[] = [];
  const created = createGoogleAddIn({
    env: ENV,
    findAccount: async () => lookup,
    jwks,
    run: async (action, context) => {
      ran.push(`${action}:${context.account.email}`);
      return notify("ran");
    },
  });

  assert.ok(created);

  return { addIn: created, ran };
}

test("with no service account or client ID there is no add-on", () => {
  assert.equal(createGoogleAddIn({ env: { APP_URL: SITE } }), null);
  assert.equal(
    createGoogleAddIn({
      env: { ...ENV, GOOGLE_ADDON_CLIENT_ID: "" },
    }),
    null,
  );
  assert.ok(createGoogleAddIn({ env: ENV }));
});

test("a verified request for a known account runs the action", async () => {
  const account = {
    email: "sam@example.com",
    id: randomUUID(),
    name: "Sam Sender",
  };
  const { addIn: handler, ran } = addIn({ account, kind: "found" });
  const response = await handler.handle(
    "gmail-message",
    request("gmail-message"),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), notify("ran"));
  assert.deepEqual(ran, ["gmail-message:sam@example.com"]);
});

test("an unknown action is not there", async () => {
  const { addIn: handler, ran } = addIn();
  const response = await handler.handle("admin", request("admin"));

  assert.equal(response.status, 404);
  assert.deepEqual(ran, []);
});

test("requests Google did not send for this add-on are refused", async () => {
  const { addIn: handler, ran } = addIn({
    account: { email: "sam@example.com", id: "u-1", name: "Sam" },
    kind: "found",
  });
  const refused = [
    // Issued for another endpoint.
    systemToken("homepage"),
    // Another service account.
    systemToken("gmail-message", {
      email: "other@project.iam.gserviceaccount.com",
    }),
    // Expired.
    systemToken("gmail-message", { exp: now() - 3600 }),
    // Not Google's issuer.
    systemToken("gmail-message", { iss: "https://evil.example" }),
  ];

  for (const system of refused) {
    const response = await handler.handle(
      "gmail-message",
      request("gmail-message", { system }),
    );

    assert.equal(response.status, 401);
  }

  const noUser = await handler.handle(
    "gmail-message",
    request("gmail-message", { user: userToken({ aud: "someone-else" }) }),
  );

  assert.equal(noUser.status, 401);
  assert.deepEqual(ran, []);
});

test("someone with no account, or not in a Workspace, is told what to do", async () => {
  const { addIn: handler, ran } = addIn({ kind: "no_account" });
  const unknown = await handler.handle("homepage", request("homepage"));

  assert.equal(unknown.status, 200);
  assert.match(JSON.stringify(await unknown.json()), /Sign in to SignuDoc/);

  const personal = await handler.handle(
    "homepage",
    request("homepage", { user: userToken({ hd: undefined }) }),
  );

  assert.equal(personal.status, 200);
  assert.match(
    JSON.stringify(await personal.json()),
    /organization&#39;s Google Workspace accounts/,
  );

  const unverified = await addIn({ kind: "unverified" }).addIn.handle(
    "homepage",
    request("homepage"),
  );

  assert.match(JSON.stringify(await unverified.json()), /Verify your email/);
  assert.deepEqual(ran, []);
});

test("a body that is not an event is refused", async () => {
  const { addIn: handler } = addIn();
  const response = await handler.handle(
    "homepage",
    new Request(`${SITE}/api/workspace/add-in/homepage`, {
      body: "not json",
      headers: { "x-forwarded-for": "10.9.9.9" },
      method: "POST",
    }),
  );

  assert.equal(response.status, 400);
});
