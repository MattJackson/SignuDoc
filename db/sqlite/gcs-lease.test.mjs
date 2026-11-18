import assert from "node:assert/strict";
import { test } from "node:test";

import { createLease, gcsLeaseStorage, revisionNumber } from "./gcs-lease.mjs";
import { leaseLocation, litestreamConfig } from "./start.mjs";

/** The lease object, as Cloud Storage keeps it: generations and all. */
function memoryStorage() {
  const state = { generation: 0, object: null };

  return {
    state,
    async read() {
      return state.object
        ? {
            body: structuredClone(state.object),
            generation: String(state.generation),
          }
        : null;
    },
    async remove(ifGeneration) {
      if (!state.object || String(state.generation) !== ifGeneration) {
        return false;
      }

      state.object = null;
      return true;
    },
    async write(body, ifGeneration) {
      const current = state.object ? String(state.generation) : "0";

      if (current !== ifGeneration) {
        return null;
      }

      state.generation += 1;
      state.object = structuredClone(body);
      return String(state.generation);
    },
  };
}

function clock(start = Date.parse("2026-11-18T00:00:00Z")) {
  const time = { now: start };

  return {
    advance: (ms) => {
      time.now += ms;
    },
    now: () => time.now,
  };
}

test("revision numbers come from Cloud Run revision names", () => {
  assert.equal(revisionNumber("signudoc-00012-abc"), 12);
  assert.equal(revisionNumber("signudoc-db-00003-x9z"), 3);
  assert.equal(revisionNumber(undefined), 0);
});

test("the first instance takes the lease, and gives it back", async () => {
  const storage = memoryStorage();
  const lease = createLease({ holder: "a", revision: "s-00001-a", storage });

  await lease.acquire();
  assert.equal(storage.state.object.holder, "a");
  assert.equal(await lease.heartbeat(), "held");
  await lease.release();
  assert.equal(storage.state.object, null);
});

test("a second instance of the same revision waits for the first", async () => {
  const storage = memoryStorage();
  const time = clock();
  const first = createLease({
    holder: "a",
    now: time.now,
    revision: "s-00001-a",
    storage,
  });

  await first.acquire();

  let acquired = false;
  const second = createLease({
    holder: "b",
    now: time.now,
    revision: "s-00001-b",
    sleep: async () => {
      // While it waits, the first keeps the lease fresh, then lets go.
      time.advance(1000);
      await first.heartbeat();

      if (time.now() - Date.parse("2026-11-18T00:00:00Z") > 5000) {
        await first.release();
      }
    },
    storage,
  });

  await second.acquire().then(() => {
    acquired = true;
  });

  assert.equal(acquired, true);
  assert.equal(storage.state.object.holder, "b");
  assert.equal(storage.state.object.handoverTo, undefined);
});

test("a lease nobody refreshes is taken over, and its old holder learns it lost it", async () => {
  const storage = memoryStorage();
  const time = clock();
  const gone = createLease({
    holder: "a",
    now: time.now,
    revision: "s-00001-a",
    storage,
  });

  await gone.acquire();
  time.advance(31_000);

  const next = createLease({
    holder: "b",
    now: time.now,
    revision: "s-00001-b",
    storage,
  });

  await next.acquire();
  assert.equal(storage.state.object.holder, "b");
  assert.equal(await gone.heartbeat(), "lost");

  // Releasing what it no longer holds leaves the new holder's lease alone.
  await gone.release();
  assert.equal(storage.state.object.holder, "b");
});

test("a newer revision asks the holder to hand over, and gets the lease", async () => {
  const storage = memoryStorage();
  const time = clock();
  const old = createLease({
    holder: "old",
    now: time.now,
    revision: "s-00004-a",
    storage,
  });

  await old.acquire();

  const handover = { asked: false };
  const newer = createLease({
    holder: "new",
    now: time.now,
    revision: "s-00005-b",
    sleep: async () => {
      time.advance(1000);

      // The holder notices on its next refresh, stops, and lets go.
      if ((await old.heartbeat()) === "handover") {
        handover.asked = true;
        await old.release();
      }
    },
    storage,
  });

  await newer.acquire();
  assert.equal(handover.asked, true);
  assert.equal(storage.state.object.holder, "new");
});

test("an older revision never takes the lease from a newer one", async () => {
  const storage = memoryStorage();
  const time = clock();
  const current = createLease({
    holder: "new",
    now: time.now,
    revision: "s-00005-a",
    storage,
  });

  await current.acquire();

  let rounds = 0;
  const older = createLease({
    holder: "old",
    now: time.now,
    revision: "s-00004-b",
    sleep: async () => {
      rounds += 1;
      time.advance(1000);
      assert.equal(await current.heartbeat(), "held");

      if (rounds === 20) {
        throw new Error("still waiting");
      }
    },
    storage,
  });

  await assert.rejects(older.acquire(), /still waiting/);
  assert.equal(storage.state.object.holder, "new");
  assert.equal(storage.state.object.handoverTo, undefined);
});

test("the Cloud Storage calls carry generation preconditions", async () => {
  const calls = [];
  const storage = gcsLeaseStorage({
    bucket: "b",
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);

      if (String(url).includes("alt=media")) {
        return new Response('{"holder":"a","revision":"r","heartbeatAt":"x"}', {
          headers: { "x-goog-generation": "7" },
        });
      }

      if (init.method === "POST") {
        return new Response(null, { status: 412 });
      }

      return new Response(null, { status: 204 });
    },
    getToken: async () => "token",
    object: "db.lease",
  });

  assert.deepEqual(await storage.read(), {
    body: { heartbeatAt: "x", holder: "a", revision: "r" },
    generation: "7",
  });
  assert.equal(
    await storage.write({ heartbeatAt: "y", holder: "b", revision: "r" }, "7"),
    null,
  );
  assert.equal(await storage.remove("7"), true);
  assert.deepEqual(calls, [
    "GET https://storage.googleapis.com/storage/v1/b/b/o/db.lease?alt=media",
    "POST https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=media&name=db.lease&ifGenerationMatch=7",
    "DELETE https://storage.googleapis.com/storage/v1/b/b/o/db.lease?ifGenerationMatch=7",
  ]);
});

test("the Litestream config and the lease sit beside the replica", () => {
  assert.deepEqual(leaseLocation("gs://bucket-db/db"), {
    bucket: "bucket-db",
    object: "db.lease",
  });
  assert.equal(leaseLocation("file:///data/replica"), null);

  const config = litestreamConfig({
    env: {},
    file: "/data/signudoc.db",
    replicaUrl: "gs://bucket-db/db",
  });

  assert.match(config, /path: "\/data\/signudoc.db"/);
  assert.match(config, /url: "gs:\/\/bucket-db\/db"/);
  assert.match(config, /sync-interval: 1s/);
  assert.match(config, /shutdown-sync-timeout: 6s/);
});
