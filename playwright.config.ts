import { generateKeyPairSync } from "node:crypto";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { ADMIN_GROUP } from "./e2e/support/google-workspace";

// One end-to-end test that walks the whole product against a real Postgres,
// with files on local disk and emails captured to JSON instead of sent.
//
//   npm run db:start   (once, for a local Postgres)
//   npm run test:e2e
//
// The test database is wiped on every run. It must have "e2e" in its name.
//
// The app is built and started in production mode, so the test sees the same
// headers, bundles and Content Security Policy as a real deployment. Set
// E2E_DEV=1 to run against "next dev" instead, which starts faster.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${String(port)}`;

export const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
export const e2eDataDir = path.resolve(".data", "e2e");
export const e2eOutboxDir = path.join(e2eDataDir, "outbox");
// First-run setup asks for this, as it does on a deployment that sets one.
export const e2eSetupToken = "e2e-setup-token";
// A stand-in for eID Easy, so the test can sign with a qualified
// certificate in the signer's own name without the real service.
const providerPort = Number(process.env.E2E_PROVIDER_PORT ?? port + 1);
// A stand-in for Google (src/lib/workspace/providers/google/test-support): sign-in,
// the Workspace directory and service account tokens. The app is pointed at
// it with the GOOGLE_*_BASE_URL variables, and given Google as its workspace
// provider, with the directory on and an administrator group, and as its
// single sign-on provider, beside password sign-in, which the other tests
// use. Only workspace.spec.ts signs in with it.
const googlePort = Number(process.env.E2E_GOOGLE_PORT ?? port + 2);
const googleUrl = `http://127.0.0.1:${String(googlePort)}`;
const googleClient = {
  id: "e2e-client.apps.googleusercontent.com",
  secret: "e2e-client-secret",
};
// A service account key made for this run. The stand-in is given it too,
// so it checks the app's signed assertions as Google would.
const googleServiceAccountKey = JSON.stringify({
  client_email: "signudoc-e2e@fake-project.iam.gserviceaccount.com",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString(),
  token_uri: "https://oauth2.googleapis.com/token",
  type: "service_account",
});
const desktop = {
  ...devices["Desktop Chrome"],
  viewport: { height: 900, width: 1440 },
};

export default defineConfig({
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  projects: [
    {
      name: "chromium",
      testIgnore: /workspace\.spec\.ts$/,
      use: desktop,
    },
    // Signing in with the workspace needs a site that has been set up, so
    // it runs on the install the tests above leave behind.
    {
      dependencies: ["chromium"],
      name: "workspace",
      testMatch: /workspace\.spec\.ts$/,
      use: desktop,
    },
  ],
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  timeout: 180_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        process.env.E2E_DEV === "1"
          ? `npx next dev --port ${String(port)}`
          : `npx next build && npx next start --port ${String(port)}`,
      env: {
        APP_URL: baseURL,
        BETTER_AUTH_SECRET: "e2e-only-secret-not-used-anywhere-else-0123456789",
        BETTER_AUTH_URL: baseURL,
        DATABASE_URL: e2eDatabaseUrl,
        EMAIL_CAPTURE_DIR: e2eOutboxDir,
        EIDEASY_API_URL: `http://127.0.0.1:${String(providerPort)}/eideasy`,
        EIDEASY_CLIENT_ID: "test-client",
        EIDEASY_SECRET: "test-secret",
        EMAIL_DRIVER: "capture",
        GOOGLE_API_BASE_URL: googleUrl,
        GOOGLE_OAUTH_BASE_URL: googleUrl,
        GOOGLE_SERVICE_ACCOUNT_KEY: googleServiceAccountKey,
        NEXT_TELEMETRY_DISABLED: "1",
        // The breach check calls an outside service; the test must not.
        PASSWORD_BREACH_CHECK: "off",
        SETUP_TOKEN: e2eSetupToken,
        SSO_CLIENT_ID: googleClient.id,
        SSO_CLIENT_SECRET: googleClient.secret,
        SSO_ISSUER: googleUrl,
        SSO_NAME: "Google",
        // "local" unless E2E_STORAGE_DRIVER says otherwise. With "blob" and a
        // BLOB_READ_WRITE_TOKEN in the environment, the same test runs against
        // a real Vercel Blob store, direct browser upload included.
        STORAGE_DRIVER: process.env.E2E_STORAGE_DRIVER ?? "local",
        STORAGE_LOCAL_DIR: path.join(e2eDataDir, "storage"),
        WORKSPACE_ADMIN_GROUP: ADMIN_GROUP,
        WORKSPACE_DIRECTORY: "on",
        WORKSPACE_PROVIDER: "google",
      },
      reuseExistingServer: false,
      timeout: 300_000,
      // Playwright starts the server before the test database is prepared:
      // on a first run, as in CI, it has no tables at all, and on later runs
      // it holds the last run's data. So the readiness check must be
      // something that never touches the database. A page would remember for
      // a minute that the site is already set up, and an API route can fail
      // outright for want of tables.
      url: `${baseURL}/icon.svg`,
    },
    {
      command:
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/support/provider-stand-in.ts",
      env: { E2E_PROVIDER_PORT: String(providerPort) },
      reuseExistingServer: false,
      timeout: 60_000,
      url: `http://127.0.0.1:${String(providerPort)}/health`,
    },
    {
      command:
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/support/google-stand-in.ts",
      env: {
        E2E_GOOGLE_CLIENT_ID: googleClient.id,
        E2E_GOOGLE_CLIENT_SECRET: googleClient.secret,
        E2E_GOOGLE_PORT: String(googlePort),
        E2E_GOOGLE_SERVICE_ACCOUNT_KEY: googleServiceAccountKey,
      },
      reuseExistingServer: false,
      timeout: 60_000,
      url: `${googleUrl}/health`,
    },
  ],
  workers: 1,
});
