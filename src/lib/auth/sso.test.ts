import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkWorkspaceAccount,
  GOOGLE_ISSUER,
  googleAuthorizationParams,
  mayUsePassword,
  readPasswordSignInPolicy,
  readSsoConfig,
  resolveWorkspaceDomains,
  ssoRedirectPath,
} from "./sso.ts";

const sso = {
  SSO_CLIENT_ID: "client",
  SSO_CLIENT_SECRET: "secret",
  SSO_ISSUER: "https://acme.okta.com/",
};

test("single sign-on is off unless all three settings are given", () => {
  assert.equal(readSsoConfig({}), null);
  assert.equal(readSsoConfig({ ...sso, SSO_CLIENT_SECRET: "" }), null);
  assert.equal(
    readSsoConfig({ ...sso, SSO_ISSUER: "http://acme.okta.com" }),
    null,
  );
  assert.equal(readSsoConfig({ ...sso, SSO_ISSUER: "not a url" }), null);
});

test("the issuer may be given with its discovery path or a trailing slash", () => {
  for (const issuer of [
    "https://acme.okta.com",
    "https://acme.okta.com/",
    "https://acme.okta.com/.well-known/openid-configuration",
  ]) {
    const config = readSsoConfig({ ...sso, SSO_ISSUER: issuer });

    assert.equal(config?.issuer, "https://acme.okta.com");
    assert.equal(
      config?.discoveryUrl,
      "https://acme.okta.com/.well-known/openid-configuration",
    );
  }

  assert.equal(readSsoConfig(sso)?.name, "single sign-on");
  assert.equal(readSsoConfig({ ...sso, SSO_NAME: "Okta" })?.name, "Okta");
});

test("password sign-in can only be turned off while single sign-on is set up", () => {
  assert.equal(
    readPasswordSignInPolicy({ PASSWORD_SIGN_IN: "off" }).enabled,
    true,
  );

  const policy = readPasswordSignInPolicy({
    ...sso,
    PASSWORD_SIGN_IN: "OFF",
    PASSWORD_SIGN_IN_ALLOWED_EMAILS: " Admin@Acme.com , ops@acme.com,",
  });

  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.allowedEmails, ["admin@acme.com", "ops@acme.com"]);
  assert.equal(mayUsePassword(policy, "ADMIN@acme.com "), true);
  assert.equal(mayUsePassword(policy, "pat@acme.com"), false);
  assert.equal(
    mayUsePassword(readPasswordSignInPolicy(sso), "pat@acme.com"),
    true,
  );
});

const storedGoogle = {
  "sso.clientId": "google-client",
  "sso.clientSecret": "google-secret",
  "sso.issuer": "https://accounts.google.com/",
};

test("single sign-on can be set in the app, and the environment wins", () => {
  const fromSettings = readSsoConfig({}, storedGoogle);

  assert.equal(fromSettings?.source, "settings");
  assert.equal(fromSettings?.issuer, GOOGLE_ISSUER);
  assert.equal(fromSettings?.google, true);
  assert.equal(fromSettings?.name, "Google");
  assert.equal(fromSettings?.clientSecret, "google-secret");

  const fromEnv = readSsoConfig(sso, storedGoogle);

  assert.equal(fromEnv?.source, "env");
  assert.equal(fromEnv?.issuer, "https://acme.okta.com");
  assert.equal(fromEnv?.google, false);

  // Any SSO_* variable means the environment decides, even half set.
  assert.equal(readSsoConfig({ SSO_CLIENT_ID: "x" }, storedGoogle), null);
  assert.equal(
    readSsoConfig({}, { ...storedGoogle, "sso.clientSecret": "" }),
    null,
  );
});

test("password sign-in can be turned off in the app while single sign-on works", () => {
  const off = readPasswordSignInPolicy(
    {},
    {
      ...storedGoogle,
      "sso.passwordAllowedEmails": "Admin@Example.com, ops@example.com",
      "sso.passwordSignIn": "off",
    },
  );

  assert.equal(off.enabled, false);
  assert.equal(off.source, "settings");
  assert.deepEqual(off.allowedEmails, ["admin@example.com", "ops@example.com"]);

  // Not without single sign-on.
  assert.equal(
    readPasswordSignInPolicy({}, { "sso.passwordSignIn": "off" }).enabled,
    true,
  );

  // PASSWORD_SIGN_IN wins over the app.
  const fromEnv = readPasswordSignInPolicy(
    { PASSWORD_SIGN_IN: "on" },
    { ...storedGoogle, "sso.passwordSignIn": "off" },
  );

  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.source, "env");
});

test("Google sign-in is held to the Workspace domains", () => {
  assert.deepEqual(
    resolveWorkspaceDomains({
      env: { GOOGLE_WORKSPACE_DOMAINS: "Example.com, example.org" },
      signupDomains: ["other.com"],
      stored: { "google.workspaceDomains": "settings.com" },
    }),
    { domains: ["example.com", "example.org"], source: "env" },
  );
  assert.deepEqual(
    resolveWorkspaceDomains({
      env: {},
      signupDomains: ["other.com"],
      stored: { "google.workspaceDomains": "settings.com" },
    }),
    { domains: ["settings.com"], source: "settings" },
  );
  assert.deepEqual(
    resolveWorkspaceDomains({
      env: {},
      signupDomains: ["example.com"],
      stored: null,
    }),
    { domains: ["example.com"], source: "signup_rule" },
  );
  assert.deepEqual(
    resolveWorkspaceDomains({ env: {}, signupDomains: [], stored: null }),
    { domains: [], source: "none" },
  );

  assert.deepEqual(googleAuthorizationParams(["example.com"]), {
    hd: "example.com",
  });
  assert.deepEqual(googleAuthorizationParams(["a.com", "b.com"]), { hd: "*" });
  assert.deepEqual(googleAuthorizationParams([]), { hd: "*" });
});

test("the hd claim decides whether a Google account is in the Workspace", () => {
  const domains = ["example.com"];

  assert.deepEqual(checkWorkspaceAccount({ hd: "Example.com" }, domains), {
    allowed: true,
  });

  const personal = checkWorkspaceAccount({ email: "pat@gmail.com" }, domains);

  assert.equal(personal.allowed, false);
  assert.equal(
    !personal.allowed && personal.code,
    "workspace_account_required",
  );

  const elsewhere = checkWorkspaceAccount({ hd: "other.com" }, domains);

  assert.equal(
    !elsewhere.allowed && elsewhere.code,
    "workspace_domain_not_allowed",
  );

  // With no domains known, any Workspace account passes, a personal one not.
  assert.equal(checkWorkspaceAccount({ hd: "other.com" }, []).allowed, true);
  assert.equal(checkWorkspaceAccount({}, []).allowed, false);
  assert.equal(checkWorkspaceAccount(undefined, []).allowed, false);
});

test("the redirect URI is Better Auth's callback for the sso provider", () => {
  assert.equal(ssoRedirectPath(), "/api/auth/callback/sso");
});
