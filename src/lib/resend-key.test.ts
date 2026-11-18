import assert from "node:assert/strict";
import { test } from "node:test";

import { checkResendApiKey, looksLikeResendKey } from "./resend-key.ts";

type ListResult = {
  data: null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: null;
};

function lister(result: ListResult | Error) {
  return {
    list: async () => {
      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  } as unknown as Parameters<typeof checkResendApiKey>[1];
}

const KEY = "re_1234567890abcdef";

test("only something shaped like a Resend key is sent to Resend", async () => {
  assert.equal(looksLikeResendKey(KEY), true);
  assert.equal(looksLikeResendKey(" re_short "), false);
  assert.equal(looksLikeResendKey("sk_live_1234567890"), false);

  const result = await checkResendApiKey(
    "not a key",
    lister(new Error("should not be called")),
  );

  assert.equal(result.ok, false);
});

test("a key that can list domains has full access", async () => {
  assert.deepEqual(
    await checkResendApiKey(
      KEY,
      lister({ data: null, error: null, headers: null }),
    ),
    { access: "full", ok: true },
  );
});

test("a key that may only send is still a working key", async () => {
  assert.deepEqual(
    await checkResendApiKey(
      KEY,
      lister({
        data: null,
        error: {
          message: "This API key is restricted to only send emails.",
          name: "restricted_api_key",
          statusCode: 401,
        },
        headers: null,
      }),
    ),
    { access: "sending", ok: true },
  );
});

test("a key Resend does not know, or cannot be asked about, is refused", async () => {
  const invalid = await checkResendApiKey(
    KEY,
    lister({
      data: null,
      error: {
        message: "API key is invalid",
        name: "invalid_api_key",
        statusCode: 403,
      },
      headers: null,
    }),
  );

  assert.equal(invalid.ok, false);
  assert.match(!invalid.ok ? invalid.message : "", /did not accept/);

  const unreachable = await checkResendApiKey(
    KEY,
    lister(new Error("offline")),
  );

  assert.equal(unreachable.ok, false);
});
