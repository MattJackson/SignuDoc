import assert from "node:assert/strict";
import { test } from "node:test";

import {
  googleSigningFor,
  isWorkspaceAddress,
  readGoogleSigningSetting,
  resolveGoogleSigningPolicy,
  type GoogleSigningPolicy,
} from "./google-signing.ts";
import { requiredSignerChecks } from "./signer-checks.ts";

// Employees signing with Google: who is asked, and when it is required.
// The check itself, against a real session, is in google-signing.dbtest.ts.

const googleSso = {
  clientId: "client",
  clientSecret: "secret",
  discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
  google: true,
  issuer: "https://accounts.google.com",
  name: "Google",
  source: "settings" as const,
};

function policy(
  overrides: Partial<GoogleSigningPolicy> = {},
): GoogleSigningPolicy {
  return {
    available: true,
    domains: ["example.com"],
    mode: "require",
    source: "settings",
    ssoIsGoogle: true,
    ...overrides,
  };
}

test("the setting is off unless set, and the environment wins", () => {
  assert.deepEqual(readGoogleSigningSetting({}, null), {
    mode: "off",
    source: "default",
  });
  assert.deepEqual(
    readGoogleSigningSetting({}, { "people.googleSigning": "offer" }),
    { mode: "offer", source: "settings" },
  );
  assert.deepEqual(
    readGoogleSigningSetting(
      { GOOGLE_SIGNING: "require" },
      { "people.googleSigning": "offer" },
    ),
    { mode: "require", source: "env" },
  );
  assert.equal(
    readGoogleSigningSetting({}, { "people.googleSigning": "maybe" }).mode,
    "off",
  );
});

test("it only applies with Google sign-in and known Workspace domains", () => {
  const setting = { mode: "require" as const, source: "settings" as const };

  assert.equal(
    resolveGoogleSigningPolicy(
      {
        sso: googleSso,
        workspaceDomains: { domains: ["example.com"], source: "settings" },
      },
      setting,
    ).available,
    true,
  );
  // No domains: an employee cannot be told from a customer.
  assert.equal(
    resolveGoogleSigningPolicy(
      { sso: googleSso, workspaceDomains: { domains: [], source: "none" } },
      setting,
    ).available,
    false,
  );
  // Another identity provider says nothing about Google Workspace.
  const other = resolveGoogleSigningPolicy(
    {
      sso: { ...googleSso, google: false, issuer: "https://login.example" },
      workspaceDomains: { domains: ["example.com"], source: "settings" },
    },
    setting,
  );

  assert.equal(other.available, false);
  assert.equal(other.ssoIsGoogle, false);
  assert.equal(
    resolveGoogleSigningPolicy(
      {
        sso: null,
        workspaceDomains: { domains: ["example.com"], source: "settings" },
      },
      setting,
    ).available,
    false,
  );
});

test("only employees are asked, never anyone outside the domains", () => {
  assert.equal(isWorkspaceAddress("pat@example.com", ["example.com"]), true);
  assert.equal(isWorkspaceAddress("pat@EXAMPLE.com", ["example.com"]), true);
  assert.equal(
    isWorkspaceAddress("pat@example.com.evil", ["example.com"]),
    false,
  );
  assert.equal(
    isWorkspaceAddress("pat@sub.example.com", ["example.com"]),
    false,
  );
  assert.equal(isWorkspaceAddress("not-an-address", ["example.com"]), false);

  const envelope = { part11: false };

  assert.equal(
    googleSigningFor(policy(), { email: "pat@example.com" }, envelope),
    "require",
  );
  assert.equal(
    googleSigningFor(policy(), { email: "client@customer.test" }, envelope),
    "off",
  );
  assert.equal(
    googleSigningFor(
      policy({ mode: "offer" }),
      { email: "pat@example.com" },
      envelope,
    ),
    "offer",
  );
  assert.equal(
    googleSigningFor(
      policy({ available: false }),
      { email: "pat@example.com" },
      envelope,
    ),
    "off",
  );
});

test("Part 11 envelopes keep their own account check and are never asked", () => {
  assert.equal(
    googleSigningFor(policy(), { email: "pat@example.com" }, { part11: true }),
    "off",
  );
});

test("a required Google check comes first and keeps every check the sender asked for", () => {
  assert.deepEqual(
    requiredSignerChecks({
      accessCodeHash: "scrypt$x$y",
      requireEmailCode: true,
      requireGoogleSignIn: true,
    }),
    ["google", "access_code", "email_code"],
  );
  assert.deepEqual(
    requiredSignerChecks({
      accessCodeHash: null,
      requireEmailCode: true,
      requireGoogleSignIn: false,
    }),
    ["email_code"],
  );
});
