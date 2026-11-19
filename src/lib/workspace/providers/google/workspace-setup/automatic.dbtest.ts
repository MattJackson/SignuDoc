import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../../../../db/connection.ts";
import { openTestDatabase } from "../../../../db/test-database.ts";
import { invalidateWorkspaceSettingsCache } from "../../../settings.ts";
import type { WorkspaceSetupEvent } from "../../../types.ts";
import {
  runWorkspaceSetup,
  submitSetupChoice,
} from "../../../workspace-setup.ts";
import { createPkcePair } from "../drive/drive-oauth.ts";
import {
  createFakeServiceAccountKey,
  FAKE_GOOGLE_CLIENT,
  startFakeGoogle,
  type FakeGoogle,
} from "../test-support/fake-google.ts";
import {
  buildSetupAuthorizationUrl,
  createGoogleAutomaticSetup,
} from "./automatic.ts";

// The one-time super admin grant of the automatic Google Workspace setup,
// from the code Google sends back to the end of the run, through the app's
// own run (workspace/workspace-setup.ts) against a real database and the
// fake Google server: the token is revoked on success, on failure and when
// time runs out, it never shows in what the page is sent, a second run at
// the same time is refused, only the person running it can answer its
// choice, and an account from another Workspace is refused. Nothing
// secret is saved. Run with `npm run test:db`.

const SITE = "https://sign.example.test";
const ADMIN = "ada@example.test";
const NOT_ADMIN = "bob@example.test";
const OUTSIDER = "eve@elsewhere.test";
const actor = { email: "installer@example.test", id: "installer-1" };

type ChooseEvent = Extract<WorkspaceSetupEvent, { type: "choose" }>;

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

async function clear() {
  await database.query(`delete from public.workspace_settings`);
  await database.query(`delete from public.workspace_setup_choices`);
  invalidateWorkspaceSettingsCache();
}

beforeEach(clear);

after(async () => {
  await clear();

  if (replaced) {
    replaceDbPoolForTests(replaced);
  }

  await database.end();
  await fake.close();
});

/** Signs in at the fake Google as this account, as the setup page does. */
async function signIn(email: string) {
  const { challenge, verifier } = createPkcePair();
  const url = new URL(
    buildSetupAuthorizationUrl({
      clientId: FAKE_GOOGLE_CLIENT.id,
      codeChallenge: challenge,
      env: process.env,
      exportDrive: false,
      redirectUri: `${SITE}/settings/workspace-setup`,
      state: "state-1",
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
  emit?: (event: WorkspaceSetupEvent) => void,
  options: {
    choose?: (offer: ChooseEvent) => string | null;
    /** Null waits as long as the setup itself would. */
    choiceWaitMs?: number | null;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const { code, verifier } = await signIn(email);
  const events: WorkspaceSetupEvent[] = [];
  const seenTokens = new Set<string>();
  const choices: Promise<boolean>[] = [];
  // The page's answer: the suggested project, as the page offers it.
  const choose =
    options.choose ??
    ((offer: ChooseEvent) => offer.preselected ?? offer.options[0]?.id ?? "");
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20))));

  await runWorkspaceSetup({
    actor,
    automatic: createGoogleAutomaticSetup({
      // The site's own checks are tested with the provider's setup; here
      // they pass.
      check: async () => [
        { id: "directory", message: "Found Ada.", name: "Directory", ok: true },
      ],
      env,
      fetchImpl: options.fetchImpl,
      sleep,
    }),
    choiceWaitMs:
      options.choiceWaitMs === null
        ? undefined
        : (options.choiceWaitMs ?? 20_000),
    code,
    emit: (event) => {
      for (const token of liveTokens(email)) {
        seenTokens.add(token);
      }

      events.push(event);

      if (event.type === "choose") {
        const choice = choose(event);

        if (choice) {
          choices.push(
            submitSetupChoice({
              choice,
              runId: event.runId,
              userId: actor.id,
            }),
          );
        }
      }

      emit?.(event);
    },
    env,
    providerId: "google",
    secret: verifier,
    sleep,
    toggles: { exportDrive: false },
  });

  await Promise.all(choices);

  return { code, events, seenTokens };
}

function finishedOf(events: WorkspaceSetupEvent[]) {
  const finished = events.filter((event) => event.type === "finished");

  assert.equal(finished.length, 1, "one finished event");

  return finished[0]?.type === "finished" ? finished[0] : null;
}

function refusalOf(events: WorkspaceSetupEvent[]): string {
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

async function storedSettings(): Promise<Record<string, string>> {
  const rows = await database.query<{ key: string; value: string }>(
    `select key, value from public.workspace_settings`,
  );

  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
}

test("a run that works revokes the token, which never reaches the page, and saves nothing secret", async () => {
  const result = await run(ADMIN);

  assert.deepEqual(finishedOf(result.events), {
    ok: true,
    revoked: true,
    type: "finished",
  });
  assert.deepEqual(liveTokens(ADMIN), []);
  assertTokenNeverSent(result);

  const saved = await storedSettings();

  assert.equal(saved["google.cloudProject"], "fake-project");
  assert.equal(saved["workspace.provider"], "google");
  assert.ok(saved["google.customerId"]);
  assert.ok(saved["google.pickerApiKey"]);
  // The values saved are the non-secret ones only.
  for (const key of Object.keys(saved)) {
    assert.match(
      key,
      /^(workspace\.provider|directory\.enabled|files\.exportDestination|google\.(cloudProject|customerId|pickerApiKey|pickerAppId|addonServiceAccount|addonClientId))$/,
    );
  }

  // Each change is in the install's audit trail as the administrator's.
  const audit = await database.query<{ actor_user_id: string }>(
    `select actor_user_id from public.system_audit_events
     where event = 'settings_changed' and actor_user_id = $1`,
    [actor.id],
  );

  assert.ok(audit.rows.length > 0);
});

test("a second run finds everything in place and changes nothing", async () => {
  await run(ADMIN);

  const before = await storedSettings();
  const again = await run(ADMIN);

  assert.equal(finishedOf(again.events)?.ok, true);
  assert.deepEqual(await storedSettings(), before);
  assert.ok(
    again.events.some(
      (event) =>
        event.type === "step" &&
        event.id === "apis" &&
        event.status === "skipped",
    ),
  );
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
  const env = { ...process.env, WORKSPACE_DIRECTORY_DOMAINS: "example.test" };
  const result = await run(OUTSIDER, env);

  assert.match(refusalOf(result.events), /not in this organization/);
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

test("the projects are offered after the sign-in, with the site's own project suggested", async () => {
  const result = await run(ADMIN);
  const offer = result.events.find((event) => event.type === "choose");

  assert.ok(offer?.type === "choose");
  assert.ok(offer.options.some((item) => item.id === "fake-project"));
  assert.ok(offer.options.some((item) => item.id === "new"));
  // The site's service account belongs to it.
  assert.equal(offer.preselected, "fake-project");
  assertTokenNeverSent(result);
});

test("no project chosen in time stops the run, and the token is still revoked", async () => {
  const result = await run(ADMIN, process.env, undefined, {
    choiceWaitMs: 100,
    choose: () => null,
  });

  assert.match(refusalOf(result.events), /No project was chosen in time/);
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
  assert.deepEqual(liveTokens(ADMIN), []);
});

test("a project that was not offered is refused, and the token revoked", async () => {
  const result = await run(ADMIN, process.env, undefined, {
    choose: () => "someone-elses",
  });

  assert.match(refusalOf(result.events), /not one this account can use/);
  assert.equal(finishedOf(result.events)?.revoked, true);
  assert.deepEqual(liveTokens(ADMIN), []);
});

test("a choice sent by someone else is not taken", async () => {
  const sent: Promise<boolean>[] = [];
  const result = await run(
    ADMIN,
    process.env,
    (event) => {
      if (event.type === "choose") {
        sent.push(
          submitSetupChoice({
            choice: "fake-project",
            runId: event.runId,
            userId: "someone-else",
          }),
        );
      }
    },
    { choiceWaitMs: 300, choose: () => null },
  );

  assert.deepEqual(await Promise.all(sent), [true]);
  assert.match(refusalOf(result.events), /No project was chosen in time/);
  assert.equal(finishedOf(result.events)?.revoked, true);
});

test("the slowest run, a late choice and the revoke included, ends inside the route's 300 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  const startedAt = Date.now();
  let offer: ChooseEvent | null = null;
  let offeredAt = 0;
  let answered = false;
  // Every Google request the run makes, the code exchange and the revoke
  // included, takes 15 seconds, the longest one is let run.
  const slowFetch: typeof fetch = async (url, init) => {
    t.mock.timers.tick(15_000);
    return fetch(url, init);
  };
  const result = await run(
    ADMIN,
    process.env,
    (event) => {
      if (event.type === "choose") {
        offer = event;
        offeredAt = Date.now();
      }
    },
    {
      choiceWaitMs: null,
      // The answer comes a second before the run stops waiting.
      choose: () => null,
      fetchImpl: slowFetch,
      sleep: async (ms) => {
        t.mock.timers.tick(ms);

        const current = offer as ChooseEvent | null;

        if (
          current &&
          !answered &&
          Date.now() >= offeredAt + current.waitSeconds * 1000 - 1000
        ) {
          answered = true;
          await submitSetupChoice({
            choice: "fake-project",
            runId: current.runId,
            userId: actor.id,
          });
        }
      },
    },
  );
  const took = Date.now() - startedAt;

  assert.ok(answered, "the choice was sent");
  assert.ok(
    result.events.some((event) => event.type === "step"),
    "steps ran after the choice",
  );
  assert.equal(finishedOf(result.events)?.revoked, true);
  assert.deepEqual(liveTokens(ADMIN), [], "revoked when time ran out");
  assert.ok(took < 300_000, `took ${String(took / 1000)} s`);
});
