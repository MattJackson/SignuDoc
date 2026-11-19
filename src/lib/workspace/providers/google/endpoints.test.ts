import assert from "node:assert/strict";
import { test } from "node:test";

import { googleUrl, readGoogleTestBase } from "./endpoints.ts";

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1/users?q=a";
const TOKEN = "https://oauth2.googleapis.com/token";

test("without the test variables, Google's own addresses are used", () => {
  assert.equal(googleUrl(DIRECTORY, {}), DIRECTORY);
  assert.equal(googleUrl(TOKEN, {}), TOKEN);
});

test("a loopback stand-in takes the place of Google, keeping the path", () => {
  const env = {
    GOOGLE_API_BASE_URL: "http://127.0.0.1:3102/",
    GOOGLE_OAUTH_BASE_URL: "http://localhost:3102/oauth",
  };

  assert.equal(
    googleUrl(DIRECTORY, env),
    "http://127.0.0.1:3102/admin/directory/v1/users?q=a",
  );
  assert.equal(googleUrl(TOKEN, env), "http://localhost:3102/oauth/token");
  assert.equal(
    googleUrl(
      "https://accounts.google.com/.well-known/openid-configuration",
      env,
    ),
    "http://localhost:3102/oauth/.well-known/openid-configuration",
  );
  assert.equal(
    googleUrl("https://www.googleapis.com/drive/v3/files", env),
    "http://127.0.0.1:3102/drive/v3/files",
  );
  // Anything that is not Google is left alone.
  assert.equal(
    googleUrl("https://login.example.com/token", env),
    "https://login.example.com/token",
  );
});

test("only a loopback address is taken, so a deployment cannot be redirected", () => {
  assert.equal(
    readGoogleTestBase(
      { GOOGLE_API_BASE_URL: "https://evil.example" },
      "GOOGLE_API_BASE_URL",
    ),
    null,
  );
  assert.equal(
    readGoogleTestBase(
      { GOOGLE_API_BASE_URL: "not a url" },
      "GOOGLE_API_BASE_URL",
    ),
    null,
  );
  assert.equal(
    googleUrl(DIRECTORY, { GOOGLE_API_BASE_URL: "http://10.0.0.5:3102" }),
    DIRECTORY,
  );
});
