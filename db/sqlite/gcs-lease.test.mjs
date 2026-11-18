import assert from "node:assert/strict";
import { test } from "node:test";

import { createLease, gcsLeaseStorage, revisionNumber } from "./gcs-lease.mjs";
import * as leaseModule from "./gcs-lease.mjs";
import * as startModule from "./start.mjs";
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
    set: (value) => {
      time.now = value;
    },
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

// --- The holder: a lease kept fresh from acquire to the end (DB-1 to DB-4) ---

const flush = async () => {
  for (let round = 0; round < 10; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Timers on the fake clock: advance() runs what falls due, in order. */
function fakeTimers(time) {
  let timers = [];
  let sequence = 0;
  const add = (run, ms) => {
    const timer = { at: time.now() + ms, id: (sequence += 1), run };

    timers.push(timer);
    return timer;
  };

  return {
    clearTimer: (timer) => {
      timers = timers.filter((candidate) => candidate !== timer);
    },
    async advance(ms) {
      const end = time.now() + ms;

      for (;;) {
        await flush();

        const due = timers
          .filter((timer) => timer.at <= end)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];

        if (!due) {
          break;
        }

        timers = timers.filter((timer) => timer !== due);
        time.set(Math.max(time.now(), due.at));
        due.run();
      }

      time.set(end);
      await flush();
    },
    setTimer: add,
    sleep: (ms) => new Promise((resolve) => add(() => resolve(undefined), ms)),
  };
}

/** A storage that can fail, hang, or lose the answer to a write that landed. */
function faulty(storage) {
  const faults = {
    calls: { read: 0, remove: 0, write: 0 },
    failWriteAt: 0,
    gate: null,
    inflight: 0,
    loseResponse: false,
    maxInflight: 0,
    read: "ok",
    write: "ok",
  };
  const guard = async (kind, run) => {
    faults.calls[kind] += 1;
    faults.inflight += 1;
    faults.maxInflight = Math.max(faults.maxInflight, faults.inflight);

    try {
      if (faults.gate) {
        await faults.gate;
      }

      const failNow =
        faults[kind] === "reject" ||
        (kind === "write" && faults.failWriteAt === faults.calls.write);

      if (failNow) {
        throw Object.assign(new Error(`${kind} is down`), { status: 503 });
      }

      if (faults[kind] === "hang") {
        return await new Promise(() => {});
      }

      return await run();
    } finally {
      faults.inflight -= 1;
    }
  };

  return {
    faults,
    read: () => guard("read", () => storage.read()),
    remove: (generation) => guard("remove", () => storage.remove(generation)),
    write: (body, generation) =>
      guard("write", async () => {
        const written = await storage.write(body, generation);

        if (faults.loseResponse && written) {
          faults.loseResponse = false;
          throw new Error("the response was lost");
        }

        return written;
      }),
  };
}

function fakeChild(events, { onKillServer } = {}) {
  let resolveExit = () => {};
  const child = {
    exit(code = 0) {
      events.push("exited");
      resolveExit(code);
    },
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
    killGroup: () => events.push("killGroup"),
    killServer: () => {
      events.push("killServer");
      onKillServer?.(child);
    },
    resume: () => events.push("resume"),
    suspend: () => events.push("suspend"),
    terminate: () => events.push("terminate"),
  };

  return child;
}

function holderRig() {
  const base = memoryStorage();
  const storage = faulty(base);
  const time = clock();
  const timers = fakeTimers(time);
  const events = [];
  const exits = [];
  const lease = createLease({
    holder: "a",
    monotonic: time.now,
    now: time.now,
    revision: "s-00001-a",
    sleep: timers.sleep,
    storage,
  });
  const options = {
    clearTimer: timers.clearTimer,
    exit: (code) => exits.push(code),
    log: () => {},
    now: time.now,
    setTimer: timers.setTimer,
  };

  return { base, events, exits, lease, options, storage, time, timers };
}

function competitor(rig, holder = "b", revision = "s-00001-b") {
  return createLease({
    holder,
    now: rig.time.now,
    revision,
    sleep: rig.timers.sleep,
    storage: rig.base,
  });
}

function heartbeatAt(base) {
  return Date.parse(base.state.object.heartbeatAt);
}

function needs(module, name) {
  assert.equal(typeof module[name], "function", `${name} is not exported`);

  return module[name];
}

test("a slow restore runs under a lease that is refreshed meanwhile", async () => {
  const holdLease = needs(leaseModule, "holdLease");
  const rig = holderRig();

  await rig.lease.acquire();

  const first = heartbeatAt(rig.base);
  const held = holdLease({ ...rig.options, lease: rig.lease });
  let taken = false;

  competitor(rig)
    .acquire()
    .then(() => {
      taken = true;
    });

  // The restore takes a minute: twice the lease's ttl.
  await rig.timers.advance(60_000);

  assert.ok(heartbeatAt(rig.base) >= first + 55_000);
  assert.equal(taken, false);
  assert.equal(rig.base.state.object.holder, "a");
  assert.deepEqual(rig.exits, []);
  await held.stop();
});

test("when Cloud Storage is down for everyone, the holder is suspended, not killed, and resumes", async () => {
  const holdLease = needs(leaseModule, "holdLease");
  const rig = holderRig();

  await rig.lease.acquire();

  const held = holdLease({ ...rig.options, lease: rig.lease });

  held.attach(fakeChild(rig.events));
  await rig.timers.advance(12_000);
  // The last write that got through was sent at 10 s.
  rig.storage.faults.write = "reject";
  rig.storage.faults.read = "reject";
  await rig.timers.advance(17_000);
  assert.deepEqual(rig.events, [], "not yet: 19 s after the last good write");
  await rig.timers.advance(3_000);
  assert.deepEqual(rig.events, ["suspend"]);
  await rig.timers.advance(15_000);
  assert.deepEqual(rig.events, ["suspend"], "suspended once, not again");
  assert.equal(rig.storage.faults.maxInflight, 1, "refreshes never overlap");

  rig.storage.faults.write = "ok";
  rig.storage.faults.read = "ok";
  await rig.timers.advance(2_000);
  assert.deepEqual(rig.events, ["suspend", "resume"]);
  assert.deepEqual(rig.exits, []);
  await held.stop();
});

test("a holder cut off from Cloud Storage alone is suspended, then stopped for good", async () => {
  const holdLease = needs(leaseModule, "holdLease");
  const rig = holderRig();

  await rig.lease.acquire();

  const held = holdLease({ ...rig.options, lease: rig.lease });

  held.attach(fakeChild(rig.events));
  await rig.timers.advance(12_000);
  rig.storage.faults.write = "reject";
  rig.storage.faults.read = "reject";

  let taken = false;

  competitor(rig)
    .acquire()
    .then(() => {
      taken = true;
    });
  await rig.timers.advance(31_000);
  assert.equal(taken, true, "the waiting instance took the stale lease");
  assert.deepEqual(rig.events, ["suspend"], "suspended before that happened");

  rig.storage.faults.write = "ok";
  rig.storage.faults.read = "ok";
  await rig.timers.advance(2_000);
  assert.deepEqual(rig.events, ["suspend", "killGroup"]);
  assert.deepEqual(rig.exits, [1]);
  assert.equal(rig.base.state.object.holder, "b");
  await held.stop();
});

test("a write that never answers does not stack refreshes, and the holder is still fenced", async () => {
  const holdLease = needs(leaseModule, "holdLease");
  const rig = holderRig();

  await rig.lease.acquire();

  const held = holdLease({ ...rig.options, lease: rig.lease });

  held.attach(fakeChild(rig.events));
  await rig.timers.advance(1_000);
  rig.storage.faults.write = "hang";
  await rig.timers.advance(40_000);
  assert.deepEqual(rig.events, ["suspend"]);
  assert.equal(rig.storage.faults.maxInflight, 1);
  // Not awaited: the write the fake storage hangs on never ends.
  void held.stop();
});

test("a handover keeps the lease fresh until the app has stopped, and kills a stuck app server first", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const removeOnBase = rig.base.remove;

  rig.base.remove = async (generation) => {
    rig.events.push("released");
    return removeOnBase(generation);
  };

  const child = fakeChild(rig.events, {
    // The final sync of the replica takes 3 s once the app server is gone.
    onKillServer: (self) => {
      rig.timers.setTimer(() => self.exit(0), 3_000);
    },
  });
  const done = startWithLease({
    holdOptions: rig.options,
    lease: rig.lease,
    log: () => {},
    migrate: async () => {},
    replicate: () => child,
    restore: async () => {},
    startWaiting: () => async () => {},
  });
  let acquired = false;

  await rig.timers.advance(1_000);
  competitor(rig, "n", "s-00002-n")
    .acquire()
    .then(() => {
      acquired = true;
      rig.events.push("acquired");
    });
  // The old holder is asked at about 1 s and notices at its next refresh.
  await rig.timers.advance(5_000);
  assert.deepEqual(rig.events, ["terminate"]);

  const before = heartbeatAt(rig.base);

  // A long request keeps the app up for 13 s more: the lease stays fresh.
  await rig.timers.advance(13_000);
  assert.ok(heartbeatAt(rig.base) >= before + 10_000, "still being refreshed");
  assert.equal(acquired, false);
  assert.deepEqual(rig.events, ["terminate"]);

  await rig.timers.advance(2_000);
  assert.deepEqual(rig.events.slice(0, 2), ["terminate", "killServer"]);

  await rig.timers.advance(10_000);
  assert.equal(await done, 0);
  assert.ok(rig.events.indexOf("exited") < rig.events.indexOf("released"));
  assert.equal(rig.events.includes("suspend"), false);
  assert.equal(acquired, true);
  assert.equal(rig.base.state.object.holder, "n");
});

test("a request for a handover is kept by the refreshes that follow it", async () => {
  const storage = memoryStorage();
  const time = clock();
  const old = createLease({
    holder: "old",
    monotonic: time.now,
    now: time.now,
    revision: "s-00004-a",
    storage,
  });

  await old.acquire();

  const asked = await storage.write(
    {
      ...storage.state.object,
      handoverTo: { holder: "new", revision: "s-00005-b" },
    },
    String(storage.state.generation),
  );

  assert.ok(asked);
  assert.equal(await old.heartbeat(), "handover");
  assert.equal(storage.state.object.handoverTo?.holder, "new");
  time.advance(5_000);
  assert.equal(await old.heartbeat(), "handover");
  assert.equal(storage.state.object.handoverTo?.holder, "new");
  assert.equal(Date.parse(storage.state.object.heartbeatAt), time.now());
});

test("only a write that went through counts as a refresh", async () => {
  const storage = memoryStorage();
  const wrapped = faulty(storage);
  const time = clock();
  const lease = createLease({
    holder: "a",
    monotonic: time.now,
    now: time.now,
    revision: "s-00001-a",
    storage: wrapped,
  });

  await lease.acquire();

  const first = lease.refreshedAt();

  // The write lands, but its answer is lost.
  time.advance(5_000);
  wrapped.faults.loseResponse = true;
  await assert.rejects(lease.heartbeat());
  assert.equal(lease.refreshedAt(), first);

  // The next write gets a 412, the read says the lease is still ours, and
  // the write that follows fails: still no refresh.
  time.advance(5_000);
  wrapped.faults.failWriteAt = wrapped.faults.calls.write + 2;
  await assert.rejects(lease.heartbeat());
  assert.equal(lease.refreshedAt(), first);

  time.advance(5_000);
  assert.equal(await lease.heartbeat(), "held");
  assert.equal(lease.refreshedAt(), first + 15_000);
});

test("the holder does not replicate over a lease taken while a migration blocked it", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const order = [];

  await assert.rejects(
    startWithLease({
      holdOptions: rig.options,
      lease: rig.lease,
      log: () => {},
      migrate: async () => {
        // A migration that blocks the event loop for longer than the ttl.
        rig.time.advance(40_000);
        await competitor(rig).acquire();
      },
      replicate: () => {
        order.push("replicate");
        return fakeChild(rig.events);
      },
      restore: async () => {},
      startWaiting: () => async () => {
        order.push("stopWaiting");
      },
    }),
  );

  assert.deepEqual(order, ["stopWaiting"]);
  assert.deepEqual(rig.exits, [1]);
  assert.equal(rig.base.state.object.holder, "b");
});

test("a restore that fails gives the lease back", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const order = [];

  await assert.rejects(
    startWithLease({
      holdOptions: rig.options,
      lease: rig.lease,
      log: () => {},
      migrate: async () => {},
      replicate: () => fakeChild(rig.events),
      restore: async () => {
        throw new Error("restore failed");
      },
      startWaiting: () => async () => {
        order.push("stopWaiting");
      },
    }),
    /restore failed/,
  );

  assert.equal(rig.base.state.object, null);
  assert.deepEqual(order, ["stopWaiting"]);
  assert.deepEqual(rig.exits, []);
});

test("the waiting server stays up until the migrations are done", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const order = [];

  const code = await startWithLease({
    holdOptions: rig.options,
    lease: rig.lease,
    log: () => {},
    migrate: async () => {
      order.push("migrate");
    },
    replicate: () => {
      order.push("replicate");
      return { ...fakeChild(rig.events), exited: Promise.resolve(0) };
    },
    restore: async () => {
      order.push("restore");
    },
    startWaiting: () => async () => {
      order.push("stopWaiting");
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(order, ["restore", "migrate", "stopWaiting", "replicate"]);
  assert.equal(rig.base.state.object, null, "released at the end");
});

test("a waiting instance retries a Cloud Storage error that comes and goes", async () => {
  const storage = memoryStorage();
  const wrapped = faulty(storage);
  const lease = createLease({
    holder: "a",
    revision: "s-00001-a",
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    storage: wrapped,
  });

  wrapped.faults.read = "reject";

  const acquiring = lease.acquire();

  await flush();
  wrapped.faults.read = "ok";
  await acquiring;
  assert.equal(storage.state.object.holder, "a");
});

test("a waiting instance does not retry a refusal", async () => {
  const lease = createLease({
    holder: "a",
    revision: "s-00001-a",
    sleep: async () => {},
    storage: {
      read: async () => {
        throw Object.assign(new Error("Reading the lease failed: 403"), {
          status: 403,
        });
      },
      remove: async () => false,
      write: async () => null,
    },
  });

  await assert.rejects(lease.acquire(), /403/);
});

test("Cloud Storage and metadata calls are given up on after a timeout", async () => {
  const hanging = (url, init) => {
    if (!init?.signal) {
      throw new Error("no abort signal was passed to fetch");
    }

    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  };
  const storage = gcsLeaseStorage({
    bucket: "b",
    fetch: hanging,
    getToken: async () => "token",
    object: "db.lease",
    timeoutMs: 20,
  });
  const timedOut = (error) => error.name === "TimeoutError";

  await assert.rejects(storage.read(), timedOut);
  await assert.rejects(storage.write({ holder: "a" }, "1"), timedOut);
  await assert.rejects(storage.remove("1"), timedOut);
  await assert.rejects(
    leaseModule.metadataServerToken(hanging, 20)(),
    timedOut,
  );
});

test("a migration that blocks the loop past the ttl does not stop a start nobody contests", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const order = [];

  const code = await startWithLease({
    holdOptions: rig.options,
    lease: rig.lease,
    log: () => {},
    migrate: async () => {
      // The loop was blocked for 40 s, so the fence timer is overdue and runs
      // as soon as the loop is free again, while a refresh is still in flight.
      let release = () => {};

      rig.storage.faults.gate = new Promise((resolve) => {
        release = resolve;
      });
      rig.time.advance(40_000);
      await rig.timers.advance(0);
      rig.storage.faults.gate = null;
      release();
    },
    replicate: () => {
      order.push("replicate");
      return { ...fakeChild(rig.events), exited: Promise.resolve(0) };
    },
    restore: async () => {},
    startWaiting: () => async () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual(order, ["replicate"]);
  assert.deepEqual(rig.exits, []);
});

test("the check before replicating retries an error that comes and goes", async () => {
  const startWithLease = needs(startModule, "startWithLease");
  const rig = holderRig();
  const order = [];
  const done = startWithLease({
    holdOptions: rig.options,
    lease: rig.lease,
    log: () => {},
    migrate: async () => {
      rig.storage.faults.write = "reject";
      rig.timers.setTimer(() => {
        rig.storage.faults.write = "ok";
      }, 2_500);
    },
    replicate: () => {
      order.push("replicate");
      return { ...fakeChild(rig.events), exited: Promise.resolve(0) };
    },
    restore: async () => {},
    startWaiting: () => async () => {},
  });

  await rig.timers.advance(10_000);
  assert.equal(await done, 0);
  assert.deepEqual(order, ["replicate"]);
  assert.deepEqual(rig.exits, []);
});

test("only a network failure is a TypeError worth retrying", async () => {
  const tries = { count: 0 };
  const failing = (error) =>
    createLease({
      holder: "a",
      revision: "s-00001-a",
      sleep: async () => {
        tries.count += 1;

        if (tries.count >= 3) {
          throw new Error("enough");
        }
      },
      storage: {
        read: async () => {
          throw error;
        },
        remove: async () => false,
        write: async () => null,
      },
    });

  await assert.rejects(
    failing(new TypeError("Cannot read properties of null")).acquire(),
    /Cannot read properties/,
  );
  assert.equal(tries.count, 0);
  await assert.rejects(
    failing(new TypeError("fetch failed")).acquire(),
    /enough/,
  );
  assert.equal(tries.count, 3);

  // What undici throws when the connection drops while the body is read.
  tries.count = 0;
  await assert.rejects(
    failing(new TypeError("terminated")).acquire(),
    /enough/,
  );
  assert.equal(tries.count, 3);
});
