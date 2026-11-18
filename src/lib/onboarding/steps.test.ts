import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSettings, type AppSettings } from "../settings.ts";
import {
  ONBOARDING_STEPS,
  readOnboardingMarks,
  type OnboardingContext,
  type OnboardingStepId,
} from "./steps.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["example.com"],
  brandColor: null,
  emailReadyAt: null,
  logoVersion: null,
  organizationName: "Example Inc",
  part11Mode: false,
  privacyUrl: null,
  requireTwoFactor: false,
  retentionDays: null,
  senderAddress: "sign@example.com",
  sessionIdleMinutes: null,
  sessionMaxHours: null,
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: "help@example.com",
  termsUrl: null,
};

function context(
  overrides: Partial<OnboardingContext> = {},
): OnboardingContext {
  const env = overrides.env ?? { RESEND_API_KEY: "re_environmentkey1" };

  return {
    env,
    marks: {},
    settings: resolveSettings(stored, env),
    stored: {},
    ...overrides,
  };
}

async function check(id: OnboardingStepId, value: OnboardingContext) {
  const step = ONBOARDING_STEPS.find((item) => item.id === id);

  assert.ok(step);

  return (await step.check(value)).status;
}

test("the steps come in the order onboarding walks them", () => {
  assert.deepEqual(
    ONBOARDING_STEPS.map((step) => step.id),
    [
      "organization",
      "email",
      "google-sign-in",
      "google-directory",
      "people",
      "storage",
      "backups",
      "retention",
    ],
  );
});

test("the people step is done once something is on, or it is confirmed off", async () => {
  assert.equal(await check("people", context()), "not_started");
  assert.equal(
    await check("people", context({ marks: { people: "confirmed" } })),
    "done",
  );
  assert.equal(
    await check(
      "people",
      context({ stored: { "people.managerPolicy": "require" } }),
    ),
    "done",
  );
  assert.equal(
    await check(
      "people",
      context({
        env: { GOOGLE_SIGNING: "offer", RESEND_API_KEY: "re_environmentkey1" },
      }),
    ),
    "done",
  );
});

test("marks are read from what is stored, and anything else is dropped", () => {
  assert.deepEqual(readOnboardingMarks({}), {});
  assert.deepEqual(readOnboardingMarks({ "onboarding.steps": "not json" }), {});
  assert.deepEqual(
    readOnboardingMarks({
      "onboarding.steps": JSON.stringify({
        backups: "confirmed",
        email: "skipped",
        nonsense: "skipped",
        retention: "done",
      }),
    }),
    { backups: "confirmed", email: "skipped" },
  );
});

test("the organization step wants a name, a support address and a closed sign-up", async () => {
  assert.equal(await check("organization", context()), "done");

  const env = {};
  const open = context({
    env,
    settings: resolveSettings({ ...stored, signupMode: "open" }, env),
  });

  assert.equal(await check("organization", open), "needs_attention");

  const unnamed = context({
    settings: resolveSettings({ ...stored, organizationName: null }, {}),
  });

  assert.equal(await check("organization", unnamed), "not_started");
});

test("email is done once the sending domain has been seen working", async () => {
  assert.equal(await check("email", context()), "needs_attention");

  const env = { RESEND_API_KEY: "re_environmentkey1" };
  const ready = context({
    env,
    settings: resolveSettings({ ...stored, emailReadyAt: 1_800_000_000 }, env),
  });

  assert.equal(await check("email", ready), "done");
  assert.equal(
    await check("email", context({ env: { EMAIL_DRIVER: "capture" } })),
    "done",
  );
});

test("Google sign-in counts as set up from the environment or from the app", async () => {
  assert.equal(await check("google-sign-in", context()), "not_started");
  assert.equal(
    await check(
      "google-sign-in",
      context({
        stored: {
          "sso.clientId": "client",
          "sso.clientSecret": "secret",
          "sso.issuer": "https://accounts.google.com",
        },
      }),
    ),
    "done",
  );
});

test("the directory step waits until the directory is turned on", async () => {
  assert.equal(await check("google-directory", context()), "not_started");
  assert.equal(
    await check(
      "google-directory",
      context({ stored: { "google.directory": "off" } }),
    ),
    "not_started",
  );
});

test("retention and backups can be confirmed as they are", async () => {
  assert.equal(await check("retention", context()), "not_started");
  assert.equal(
    await check("retention", context({ marks: { retention: "confirmed" } })),
    "done",
  );
  assert.equal(
    await check(
      "retention",
      context({
        settings: resolveSettings({ ...stored, retentionDays: 365 }, {}),
      }),
    ),
    "done",
  );
  assert.equal(await check("backups", context()), "not_started");
  assert.equal(
    await check("backups", context({ marks: { backups: "confirmed" } })),
    "done",
  );
});

test("storage is described from the deployment's setting", async () => {
  assert.equal(
    await check("storage", context({ env: { STORAGE_DRIVER: "local" } })),
    "done",
  );
  assert.equal(
    await check("storage", context({ env: { STORAGE_DRIVER: "floppy" } })),
    "needs_attention",
  );
});
