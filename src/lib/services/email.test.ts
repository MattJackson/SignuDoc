import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "pg";
import type { Resend } from "resend";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { invalidateIntegrationSettingsCache } from "../integration-settings.ts";
import {
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  type EmailService,
} from "./email.ts";
import { ServiceConfigurationError } from "./service-config.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

// The Resend key saved in the app, as the settings cache holds it.
function cacheStoredKey(key: string | null) {
  globalThis.__signudocIntegrationSettings = {
    expiresAt: Date.now() + 60_000,
    value: key ? { "resend.apiKey": key } : {},
  };
}

const addresses = async () => ({
  senderAddress: "Example <hello@example.test>",
  supportAddress: null,
});

test("mail goes out with the Resend key saved now, not the one saved when the service was made", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: (string | null)[] = [];

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));

    return Response.json({ id: "email_1" });
  }) as typeof fetch;

  try {
    cacheStoredKey("re_keyA");

    const service = createEmailService({
      env: {},
      resolveAddresses: addresses,
    });

    await service.send(MESSAGE);
    // The key is replaced in Settings while the service is still in use.
    cacheStoredKey("re_keyB");
    await service.send(MESSAGE);

    assert.deepEqual(authorizations, ["Bearer re_keyA", "Bearer re_keyB"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__signudocIntegrationSettings = undefined;
  }
});

test("a saved key is looked for again after a startup read that failed", async () => {
  const database = {
    queries: 0,
    async query() {
      database.queries += 1;

      return {
        rows: [{ key: "resend.apiKey", secret: false, value: "re_saved" }],
      };
    },
  };
  const replaced = replaceDbPoolForTests(database as unknown as Pool);

  globalThis.__signudocIntegrationSettings = undefined;

  try {
    assert.throws(
      () => createEmailService({ env: {}, resolveAddresses: addresses }),
      ServiceConfigurationError,
    );

    for (let turn = 0; turn < 20 && database.queries === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(database.queries, 1, "the settings were read");
    await new Promise((resolve) => setImmediate(resolve));

    assert.doesNotThrow(() =>
      createEmailService({ env: {}, resolveAddresses: addresses }),
    );
  } finally {
    if (replaced) {
      replaceDbPoolForTests(replaced);
    }

    globalThis.__signudocIntegrationSettings = undefined;
  }
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /RESEND_API_KEY/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  // A key saved in the app counts too; earlier tests here leave one read.
  invalidateIntegrationSettingsCache();
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
});
