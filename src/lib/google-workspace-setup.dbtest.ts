import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { runAutomaticSetup } from "./google-workspace-setup.ts";
import { invalidateIntegrationSettingsCache } from "./integration-settings.ts";
import {
  createFakeServiceAccountKey,
  FAKE_GOOGLE_CLIENT,
  startFakeGoogle,
  type FakeGoogle,
} from "./integrations/google/test-support/fake-google.ts";
import {
  buildSetupAuthorizationUrl,
  newSetupState,
  SETUP_CALLBACK_PATH,
  type SetupEvent,
} from "./integrations/google/workspace-setup.ts";

// The one-time super admin grant of the automatic Google Workspace setup,
// from the code Google sends back to the end of the run, against a real
// database and the fake Google server: the token is revoked whatever
// happened, never shows in what the page is sent, a second run at the same
// time is refused, and an account from another Workspace is refused. Run
// with `npm run test:db`.

const SITE = "https://sign.example.test";
const ADMIN = "ada@example.test";
const NOT_ADMIN = "bob@example.test";
const OUTSIDER = "eve@elsewhere.test";
const actor = { email: "installer@example.test", id: "installer-1" };

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let fake: FakeGoogle;

before(async () => {
  fake = await startFakeGoogle({
    users: [
      { email: ADMIN, familyName: "Admin", givenName: "Ada", isAdmin: true },
      { email: NOT_ADMIN, familyName: "User", givenName: "Bob" },
      {
        email: OUTSIDER,
        familyName: "Else",
        givenName: "Eve",
        isAdmin: true,
      },
    ],
  });

  // The Google clients that take no env read these.
  Object.assign(process.env, {
    ...fake.env,
    APP_URL: SITE,
    BETTER_AUTH_SECRET: "a".repeat(40),
    GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(createFakeServiceAccountKey()),
    SSO_CLIENT_ID: FAKE_GOOGLE_CLIENT.id,
    SSO_CLIENT_SECRET: FAKE_GOOGLE_CLIENT.secret,
    SSO_ISSUER: "https://accounts.google.com",
  });

  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});

beforeEach(async () => {
  await database.query(`delete from public.integration_settings`);
  invalidateIntegrationSettingsCache();
});

after(async () => {
  await database.query(`delete from public.integration_settings`);

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
  await fake.close();
});

/** Signs in at the fake Google as this account, as the setup page does. */
async function signIn(email: string) {
  const { challenge, state, verifier } = newSetupState();
  const url = new URL(
    buildSetupAuthorizationUrl({
      clientId: FAKE_GOOGLE_CLIENT.id,
      codeChallenge: challenge,
      exportDrive: false,
      redirectUri: `${SITE}${SETUP_CALLBACK_PATH}`,
      state,
    }),
  );

  url.searchParams.set("login_hint", email);

  const response = await fetch(url, { redirect: "manual" });
  const code = new URL(response.headers.get("location") ?? "").searchParams.get(
    "code",
  );

  assert.ok(code, "Google sent a code back");

  return { code, verifier };
}

/** The access tokens Google holds for this person's sign-in. */
function liveTokens(email: string): string[] {
  return Array.from(fake.state.accessTokens.entries())
    .filter(([, token]) => token.user === email && !token.serviceAccount)
    .map(([value]) => value);
}

async function run(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
  emit?: (event: SetupEvent) => void,
) {
  const { code, verifier } = await signIn(email);
  const events: SetupEvent[] = [];
  const seenTokens = new Set<string>();

  await runAutomaticSetup({
    actor,
    code,
    codeVerifier: verifier,
    emit: (event) => {
      for (const token of liveTokens(email)) {
        seenTokens.add(token);
      }

      events.push(event);
      emit?.(event);
    },
    env,
    exportDrive: false,
  });

  return { code, events, seenTokens };
}

function finishedOf(events: SetupEvent[]) {
  const finished = events.filter((event) => event.type === "finished");

  assert.equal(finished.length, 1, "one finished event");

  return finished[0]?.type === "finished" ? finished[0] : null;
}

function refusalOf(events: SetupEvent[]): string {
  const refused = events.find((event) => event.type === "refused");

  return refused?.type === "refused" ? refused.message : "";
}

function assertTokenNeverSent(result: Awaited<ReturnType<typeof run>>) {
  const sent = JSON.stringify(result.events);

  assert.ok(result.seenTokens.size > 0, "a token was issued");

  for (const token of result.seenTokens) {
    assert.ok(!sent.includes(token), "the token is not in any event");
  }
}

test("a run that works revokes the token, which never reaches the page", async () => {
  const result = await run(ADMIN);

  assert.deepEqual(finishedOf(result.events), {
    ok: true,
    revoked: true,
    type: "finished",
  });
  assert.deepEqual(liveTokens(ADMIN), []);
  assertTokenNeverSent(result);
});

test("a run that is refused still revokes the token", async () => {
  const result = await run(NOT_ADMIN);

  assert.match(refusalOf(result.events), /not a Workspace super admin/);
  assert.deepEqual(finishedOf(result.events), {
    ok: false,
    revoked: true,
    type: "finished",
  });
  assert.deepEqual(liveTokens(NOT_ADMIN), []);
  assertTokenNeverSent(result);
});

test("a page that went away mid-run does not keep the token alive", async () => {
  let thrown = false;
  const result = await run(ADMIN, process.env, (event) => {
    if (!thrown && event.type === "step") {
      thrown = true;
      throw new TypeError("Invalid state: Controller is already closed");
    }
  });

  assert.ok(thrown);
  assert.equal(finishedOf(result.events)?.revoked, true);
  assert.deepEqual(liveTokens(ADMIN), []);
});

test("a site that cannot run the setup refuses before the code is used", async () => {
  const env = { ...process.env, APP_URL: "", BETTER_AUTH_URL: "" };
  const result = await run(ADMIN, env);

  assert.match(refusalOf(result.events), /APP_URL/);
  assert.equal(finishedOf(result.events)?.ok, false);
  assert.ok(fake.state.codes.has(result.code), "the code was not exchanged");
  assert.deepEqual(liveTokens(ADMIN), []);
});

test("an account from another Workspace is refused, and its token revoked", async () => {
  const env = { ...process.env, GOOGLE_WORKSPACE_DOMAINS: "example.test" };
  const result = await run(OUTSIDER, env);

  assert.match(refusalOf(result.events), /Workspace/);
  assert.deepEqual(
    result.events.filter((event) => event.type === "step"),
    [],
    "no step was run",
  );
  assert.deepEqual(finishedOf(result.events), {
    ok: false,
    revoked: true,
    type: "finished",
  });
  assert.deepEqual(liveTokens(OUTSIDER), []);
});

test("a second run while one is going is refused", async () => {
  const [first, second] = await Promise.all([run(ADMIN), run(ADMIN)]);
  const refusals = [first, second].map((result) => refusalOf(result.events));

  assert.equal(
    refusals.filter((message) => /already running/.test(message)).length,
    1,
    refusals.join(" | "),
  );
  assert.equal(finishedOf(first.events)?.revoked, true);
  assert.equal(finishedOf(second.events)?.revoked, true);
  assert.deepEqual(liveTokens(ADMIN), []);
});
