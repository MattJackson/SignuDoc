import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSlackBlocks,
  createSlackChannelWithFetch,
  escapeSlackText,
  resolveSlackToken,
  slackBotTokenSchema,
} from "./channel.ts";
import {
  classifySlackError,
  createSlackClient,
  type SlackFetch,
} from "./client.ts";
import { buildSlackManifest, SLACK_BOT_SCOPES } from "./manifest.ts";

// The Slack client against a fake fetch: what it sends, how it reads
// Slack's answers, and that a failure keeps only Slack's status and error
// code.

type Call = { body: string; headers: Record<string, string>; url: string };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetch: SlackFetch;
} {
  const calls: Call[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      const call = {
        body: String(init.body ?? ""),
        headers: init.headers as Record<string, string>,
        url,
      };

      calls.push(call);

      return respond(call);
    },
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

const TOKEN = "xoxb-1234567890-abcdefghij";

test("users.lookupByEmail is sent form-encoded with the bot token", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ ok: true, user: { id: "U012345", name: "riley" } }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });
  const result = await client.lookupUserByEmail("riley@example.com");

  assert.deepEqual(result, { ok: true, userId: "U012345" });
  assert.equal(calls[0]?.url, "https://slack.com/api/users.lookupByEmail");
  assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(
    calls[0]?.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(calls[0]?.body, "email=riley%40example.com");
});

test("nobody with that address, or a deactivated account, is not found", async () => {
  const missing = createSlackClient({
    fetch: fakeFetch(() => json({ error: "users_not_found", ok: false })).fetch,
    token: TOKEN,
  });
  const deleted = createSlackClient({
    fetch: fakeFetch(() =>
      json({ ok: true, user: { deleted: true, id: "U0GONE" } }),
    ).fetch,
    token: TOKEN,
  });

  assert.equal((await missing.lookupUserByEmail("a@example.com")).ok, false);
  assert.deepEqual(await deleted.lookupUserByEmail("a@example.com"), {
    error: "users_not_found",
    ok: false,
    retryAfterSeconds: null,
    status: 200,
  });
});

test("chat.postMessage is sent as JSON, without unfurling or mentions", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ channel: "C0123456", ok: true, ts: "1700000000.000100" }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });
  const result = await client.postMessage({
    blocks: [{ type: "section" }],
    channel: "C0123456",
    text: "Hello",
  });

  assert.deepEqual(result, {
    channel: "C0123456",
    ok: true,
    ts: "1700000000.000100",
  });
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  assert.equal(
    calls[0]?.headers["content-type"],
    "application/json; charset=utf-8",
  );

  const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;

  assert.equal(body.channel, "C0123456");
  assert.equal(body.text, "Hello");
  assert.equal(body.link_names, false);
  assert.equal(body.unfurl_links, false);
  assert.deepEqual(body.blocks, [{ type: "section" }]);
});

test("a rate limit keeps Slack's Retry-After", async () => {
  const client = createSlackClient({
    fetch: fakeFetch(
      () =>
        new Response("slow down", {
          headers: { "retry-after": "42" },
          status: 429,
        }),
    ).fetch,
    token: TOKEN,
  });
  const result = await client.postMessage({ channel: "C0123456", text: "x" });

  assert.deepEqual(result, {
    error: "ratelimited",
    ok: false,
    retryAfterSeconds: 42,
    status: 429,
  });
  assert.ok(!result.ok);
  assert.deepEqual(classifySlackError(result), {
    error: "ratelimited",
    outcome: "rate_limited",
    retryAfterSeconds: 42,
  });
});

test("a rate limit without Retry-After waits a default time", async () => {
  const client = createSlackClient({
    fetch: fakeFetch(() => new Response(null, { status: 429 })).fetch,
    token: TOKEN,
  });
  const result = await client.authTest();

  assert.ok(!result.ok);
  assert.equal(result.retryAfterSeconds, 30);
});

test("errors are classified by status and code alone", () => {
  const base = { ok: false as const, retryAfterSeconds: null, status: 200 };

  assert.equal(
    classifySlackError({ ...base, error: "invalid_auth" }).outcome,
    "auth",
  );
  assert.equal(
    classifySlackError({ ...base, error: "token_revoked" }).outcome,
    "auth",
  );
  assert.equal(
    classifySlackError({ ...base, error: "channel_not_found" }).outcome,
    "failed",
  );
  assert.equal(
    classifySlackError({ ...base, error: "not_in_channel" }).outcome,
    "failed",
  );
  assert.equal(
    classifySlackError({ ...base, error: "internal_error" }).outcome,
    "retry",
  );
  assert.equal(
    classifySlackError({ ...base, error: "http_503", status: 503 }).outcome,
    "retry",
  );
  assert.equal(
    classifySlackError({ ...base, error: "network_error", status: 0 }).outcome,
    "retry",
  );
});

test("a failed call keeps no part of what Slack sent back but a safe code", async () => {
  const leaky = createSlackClient({
    fetch: fakeFetch(() =>
      json({
        error: "<script>secret xoxb-leak</script>",
        ok: false,
        warning: "something private",
      }),
    ).fetch,
    token: TOKEN,
  });
  const result = await leaky.authTest();

  assert.deepEqual(result, {
    error: "unknown_error",
    ok: false,
    retryAfterSeconds: null,
    status: 200,
  });

  const broken = createSlackClient({
    fetch: fakeFetch(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ).fetch,
    token: TOKEN,
  });

  assert.deepEqual(await broken.authTest(), {
    error: "http_502",
    ok: false,
    retryAfterSeconds: null,
    status: 502,
  });
});

test("a network failure is a retry, not a crash", async () => {
  const client = createSlackClient({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    token: TOKEN,
  });
  const result = await client.postMessage({ channel: "C0123456", text: "x" });

  assert.ok(!result.ok);
  assert.equal(result.error, "network_error");
  assert.equal(classifySlackError(result).outcome, "retry");
});

test("auth.test and conversations.list are read", async () => {
  const { calls, fetch } = fakeFetch((call) =>
    call.url.endsWith("auth.test")
      ? json({ ok: true, team: "Example", team_id: "T1", user_id: "U1" })
      : json({
          channels: [
            { id: "C1", is_member: true, name: "sales" },
            { id: "C2", name: "general" },
            { name: "no-id" },
          ],
          ok: true,
          response_metadata: { next_cursor: "" },
        }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  assert.deepEqual(await client.authTest(), {
    botUserId: "U1",
    ok: true,
    team: "Example",
    teamId: "T1",
    url: null,
  });
  assert.deepEqual(await client.listChannels(), {
    channels: [
      { id: "C1", isMember: true, isPrivate: false, name: "sales" },
      { id: "C2", isMember: false, isPrivate: false, name: "general" },
    ],
    nextCursor: null,
    ok: true,
  });
  assert.match(calls[1]?.body ?? "", /types=public_channel/);
  assert.match(calls[1]?.body ?? "", /exclude_archived=true/);
});

test("the channel looks people up and sends Block Kit messages", async () => {
  const { calls, fetch } = fakeFetch((call) =>
    call.url.endsWith("users.lookupByEmail")
      ? json({ ok: true, user: { id: "U777" } })
      : json({ channel: "U777", ok: true, ts: "1.2" }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const context = { env: { SLACK_BOT_TOKEN: TOKEN }, stored: {} };

  assert.deepEqual(await channel.lookupUser("a@example.com", context), {
    externalId: "U777",
    outcome: "found",
  });
  assert.deepEqual(
    await channel.send(
      "U777",
      {
        fields: [{ label: "Status", value: "Completed" }],
        headline: 'Riley signed "NDA <v2>"',
        kind: "envelope_signed",
        link: {
          label: "Open envelope",
          url: "https://sign.example.com/envelopes/e1",
        },
        text: 'Riley signed "NDA <v2>"',
      },
      context,
    ),
    { outcome: "sent" },
  );

  const body = JSON.parse(calls[1]?.body ?? "{}") as {
    blocks: { elements?: { url?: string }[]; text?: { text: string } }[];
    text: string;
  };

  assert.equal(body.text, 'Riley signed "NDA &lt;v2&gt;"');
  assert.equal(body.blocks[0]?.text?.text, '*Riley signed "NDA &lt;v2&gt;"*');
  assert.equal(
    body.blocks[2]?.elements?.[0]?.url,
    "https://sign.example.com/envelopes/e1",
  );
});

test("without a token the channel is not set up and sends nothing", async () => {
  const { calls, fetch } = fakeFetch(() => json({ ok: true }));
  const channel = createSlackChannelWithFetch(fetch);
  const context = { env: {}, stored: {} };

  assert.deepEqual(channel.status(context), {
    configured: false,
    directMessages: false,
    source: null,
  });
  assert.equal(
    (
      await channel.send(
        "C1",
        {
          fields: [],
          headline: "x",
          kind: "envelope_sent",
          link: null,
          text: "x",
        },
        context,
      )
    ).outcome,
    "failed",
  );
  assert.equal(calls.length, 0);
});

test("the environment's token wins over the stored one, and direct messages can be off", () => {
  assert.deepEqual(
    resolveSlackToken(
      { SLACK_BOT_TOKEN: "xoxb-from-environment-1" },
      { "slack.botToken": "xoxb-from-settings-1" },
    ),
    { source: "env", token: "xoxb-from-environment-1" },
  );
  assert.deepEqual(
    resolveSlackToken({}, { "slack.botToken": "xoxb-from-settings-1" }),
    { source: "settings", token: "xoxb-from-settings-1" },
  );

  const channel = createSlackChannelWithFetch(async () => json({ ok: true }));

  assert.equal(
    channel.status({
      env: {},
      stored: {
        "notifications.slack.directMessages": "off",
        "slack.botToken": "xoxb-from-settings-1",
      },
    }).directMessages,
    false,
  );
});

test("only bot tokens are accepted", () => {
  assert.equal(slackBotTokenSchema.safeParse(TOKEN).success, true);
  assert.equal(
    slackBotTokenSchema.safeParse("xoxp-1234567890-abc").success,
    false,
  );
  assert.equal(slackBotTokenSchema.safeParse("hello").success, false);
});

test("text is escaped so a title cannot become a mention or a link", () => {
  assert.equal(
    escapeSlackText("<!channel> & <https://evil.example|click>"),
    "&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;",
  );

  const blocks = buildSlackBlocks({
    fields: [],
    headline: "<@U1>",
    kind: "envelope_sent",
    link: null,
    text: "<@U1>",
  });

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    text: { text: "*&lt;@U1&gt;*", type: "mrkdwn" },
    type: "section",
  });
});

test("the manifest asks for the minimal scopes and names this site", () => {
  const manifest = buildSlackManifest({
    appName: "Example Signing",
    siteUrl: "https://sign.example.com",
  }) as {
    display_information: { description: string; name: string };
    oauth_config: { scopes: { bot: string[] } };
  };

  assert.deepEqual(manifest.oauth_config.scopes.bot, [...SLACK_BOT_SCOPES]);
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    "chat:write",
    "users:read",
    "users:read.email",
    "channels:read",
  ]);
  assert.match(manifest.display_information.description, /sign\.example\.com/);
  assert.ok(manifest.display_information.description.length <= 140);
  assert.equal(manifest.display_information.name, "Example Signing");
});
