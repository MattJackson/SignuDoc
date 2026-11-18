// A lease on the SQLite database, kept as one object in the Cloud Storage
// bucket beside the Litestream replica, so that only one instance ever
// writes the database, even while Cloud Run runs an old and a new revision
// side by side during a deploy. See docs/design/database-backends.md,
// "Durability on Cloud Run with Litestream".
//
// Every change to the object is made with a generation precondition, so of
// two instances that try at once exactly one succeeds.
//
// - Absent: the first to create it holds it.
// - Held and refreshed (heartbeatAt within ttlMs): wait. A newer revision
//   asks the holder to hand over (handoverTo); the holder stops its app,
//   lets Litestream finish its last sync, and deletes the lease.
// - Held but not refreshed for ttlMs: its holder is gone; take it.
// - A holder that finds the lease taken from it stops at once.

/**
 * The revision number in a Cloud Run revision name, signudoc-00012-abc.
 *
 * @param {string | undefined | null} revision
 * @returns {number}
 */
export function revisionNumber(revision) {
  const match = /-(\d+)-[a-z0-9]+$/.exec(revision ?? "");

  return match ? Number(match[1]) : 0;
}

/**
 * @typedef {{ holder: string, revision: string, heartbeatAt: string,
 *   handoverTo?: { holder: string, revision: string } }} LeaseBody
 * @typedef {{ body: LeaseBody, generation: string }} LeaseObject
 * @typedef {{
 *   read(): Promise<LeaseObject | null>,
 *   write(body: LeaseBody, ifGeneration: string): Promise<string | null>,
 *   remove(ifGeneration: string): Promise<boolean>,
 * }} LeaseStorage
 */

/**
 * A failed call to Cloud Storage or the metadata server, with the HTTP status.
 */
export class LeaseHttpError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = "LeaseHttpError";
    this.status = status;
  }
}

/**
 * Whether a failed call is worth trying again: the network or a timeout
 * (no status), a request timeout, throttling, or a server error. A refusal
 * (400, 401, 403, 404) is not: waiting does not fix a missing grant.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientLeaseError(error) {
  const status = /** @type {{ status?: unknown }} */ (error)?.status;

  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }

  const name = /** @type {{ name?: unknown }} */ (error)?.name;

  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    // What fetch throws when the network fails; any other TypeError is a bug.
    (name === "TypeError" &&
      /fetch failed/.test(
        String(/** @type {{ message?: unknown }} */ (error).message),
      ))
  );
}
/**
 * The lease object in Cloud Storage, through the JSON API. `write` and
 * `remove` return null / false when the precondition fails. Every call is
 * given up on after `timeoutMs`, so that a hung connection cannot stall the
 * holder's refreshes.
 *
 * @param {{ bucket: string, object: string, getToken: () => Promise<string>,
 *   fetch?: typeof fetch, timeoutMs?: number }} options
 * @returns {LeaseStorage}
 */
export function gcsLeaseStorage({
  bucket,
  object,
  getToken,
  fetch = globalThis.fetch,
  timeoutMs = 3_000,
}) {
  const base = "https://storage.googleapis.com";
  const name = encodeURIComponent(object);
  const headers = async () => ({ authorization: `Bearer ${await getToken()}` });

  return {
    async read() {
      const response = await fetch(
        `${base}/storage/v1/b/${bucket}/o/${name}?alt=media`,
        {
          headers: await headers(),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new LeaseHttpError(
          `Reading the lease failed: ${String(response.status)}`,
          response.status,
        );
      }

      return {
        body: /** @type {LeaseBody} */ (await response.json()),
        generation: response.headers.get("x-goog-generation") ?? "",
      };
    },
    async write(body, ifGeneration) {
      const response = await fetch(
        `${base}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}&ifGenerationMatch=${ifGeneration}`,
        {
          body: JSON.stringify(body),
          headers: { ...(await headers()), "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.status === 412) {
        return null;
      }

      if (!response.ok) {
        throw new LeaseHttpError(
          `Writing the lease failed: ${String(response.status)}`,
          response.status,
        );
      }

      const written = /** @type {{ generation: string }} */ (
        await response.json()
      );

      return String(written.generation);
    },
    async remove(ifGeneration) {
      const response = await fetch(
        `${base}/storage/v1/b/${bucket}/o/${name}?ifGenerationMatch=${ifGeneration}`,
        {
          headers: await headers(),
          method: "DELETE",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.status === 412 || response.status === 404) {
        return false;
      }

      if (!response.ok) {
        throw new LeaseHttpError(
          `Releasing the lease failed: ${String(response.status)}`,
          response.status,
        );
      }

      return true;
    },
  };
}

/**
 * An access token from the metadata server: the service account Cloud Run
 * runs as. Cached until a minute before it expires.
 *
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {() => Promise<string>}
 */
export function metadataServerToken(
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
) {
  /** @type {{ token: string, until: number } | null} */
  let cached = null;

  return async () => {
    if (cached && cached.until > Date.now()) {
      return cached.token;
    }

    const response = await fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "metadata-flavor": "Google" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      throw new LeaseHttpError(
        `The metadata server gave no token: ${String(response.status)}`,
        response.status,
      );
    }

    const { access_token: token, expires_in: seconds } =
      /** @type {{ access_token: string, expires_in: number }} */ (
        await response.json()
      );

    cached = { token, until: Date.now() + (seconds - 60) * 1000 };
    return token;
  };
}

/** @param {unknown} error */
function describeError(error) {
  const { name, status } = /** @type {{ name?: unknown, status?: unknown }} */ (
    error ?? {}
  );

  return typeof status === "number"
    ? `Cloud Storage answered ${String(status)}`
    : `Cloud Storage could not be reached (${String(name ?? "error")})`;
}

/**
 * @param {{
 *   storage: LeaseStorage,
 *   holder: string,
 *   revision: string,
 *   ttlMs?: number,
 *   pollMs?: number,
 *   now?: () => number,
 *   monotonic?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} options
 */
export function createLease({
  storage,
  holder,
  revision,
  ttlMs = 30_000,
  pollMs = 1_000,
  now = Date.now,
  // The clock the holder fences itself by. A step of the wall clock cannot
  // move it; the heartbeatAt that other instances read stays wall-clock time.
  monotonic = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  /** @type {string | null} */
  let generation = null;
  /** @type {number | null} */
  let refreshedAt = null;
  /** @type {{ holder: string, revision: string } | undefined} */
  let handoverTo;
  const body = () => ({
    heartbeatAt: new Date(now()).toISOString(),
    holder,
    revision,
    // A refresh must not erase the request of a newer revision.
    ...(handoverTo ? { handoverTo } : {}),
  });

  return {
    /**
     * Waits until this instance holds the lease. An error that comes and
     * goes (the network, a timeout, throttling, a server error) is waited
     * out; a refusal is thrown.
     */
    async acquire() {
      let reported = false;
      let failures = 0;
      let failure = "";

      handoverTo = undefined;

      /** @returns {Promise<"taken" | "again" | "wait">} */
      const attempt = async () => {
        const current = await storage.read();

        if (!current) {
          const sentAt = monotonic();

          generation = await storage.write(body(), "0");

          if (generation) {
            refreshedAt = sentAt;
            log("[lease] taken");
            return "taken";
          }

          return "again";
        }

        const age = now() - Date.parse(current.body.heartbeatAt);

        if (current.body.holder === holder || !(age < ttlMs)) {
          const sentAt = monotonic();

          generation = await storage.write(body(), current.generation);

          if (generation) {
            refreshedAt = sentAt;
            log(
              current.body.holder === holder
                ? "[lease] taken back"
                : `[lease] taken over from ${current.body.holder}, silent for ${String(Math.round(age / 1000))} s`,
            );
            return "taken";
          }

          return "again";
        }

        if (!reported) {
          log(
            `[lease] held by ${current.body.holder} (${current.body.revision}); waiting`,
          );
          reported = true;
        }

        // A newer revision asks the older one to hand over.
        if (
          revisionNumber(revision) > revisionNumber(current.body.revision) &&
          current.body.handoverTo?.holder !== holder
        ) {
          const asked = await storage.write(
            { ...current.body, handoverTo: { holder, revision } },
            current.generation,
          );

          if (asked) {
            log(`[lease] asked ${current.body.holder} to hand over`);
          }
        }

        return "wait";
      };

      for (;;) {
        /** @type {"taken" | "again" | "wait"} */
        let outcome;

        try {
          outcome = await attempt();
        } catch (error) {
          if (!isTransientLeaseError(error)) {
            throw error;
          }

          failures += 1;

          const what = describeError(error);

          if (what !== failure) {
            log(`[lease] ${what}; trying again`);
            failure = what;
          }

          await sleep(Math.min(1_000 * 2 ** (failures - 1), 10_000));
          continue;
        }

        failures = 0;
        failure = "";

        if (outcome === "taken") {
          return;
        }

        if (outcome === "wait") {
          await sleep(pollMs);
        }
      }
    },

    /**
     * Refreshes the lease. "held" while it is still ours, "handover" when a
     * newer revision has asked for it, "lost" when someone else has it, and
     * "failed" when the lease is still ours but could not be written. A
     * storage error is thrown.
     *
     * @returns {Promise<"held" | "handover" | "lost" | "failed">}
     */
    async heartbeat() {
      if (!generation) {
        return "lost";
      }

      let sentAt = monotonic();
      let written = await storage.write(body(), generation);

      if (!written) {
        // Someone changed the object: a newer revision asking for a
        // handover, or someone taking the lease from us.
        const current = await storage.read();

        if (!current || current.body.holder !== holder) {
          generation = null;
          return "lost";
        }

        generation = current.generation;
        handoverTo = current.body.handoverTo;
        sentAt = monotonic();
        written = await storage.write(body(), generation);

        if (!written) {
          return "failed";
        }
      }

      generation = written;
      // Only a write that went through moves it: not a 412 followed by a
      // read, which stores no new heartbeatAt.
      refreshedAt = sentAt;

      return handoverTo &&
        revisionNumber(handoverTo.revision) > revisionNumber(revision)
        ? "handover"
        : "held";
    },

    /**
     * When the last write that went through was sent, on the monotonic
     * clock, or null before the lease was taken.
     *
     * @returns {number | null}
     */
    refreshedAt: () => refreshedAt,

    /** Gives the lease up, if it is still ours. */
    async release() {
      for (let attempt = 0; attempt < 3 && generation; attempt += 1) {
        if (await storage.remove(generation)) {
          generation = null;
          log("[lease] released");
          return;
        }

        const current = await storage.read();

        generation =
          current && current.body.holder === holder ? current.generation : null;
      }
    },
  };
}

/**
 * @typedef {{
 *   terminate(): void, killServer(): void, killGroup(): void,
 *   suspend(): void, resume(): void, exited: Promise<number>,
 * }} HeldChild
 */

/**
 * Keeps the lease while the database is in use, from the moment it is taken.
 *
 * - It refreshes the lease every `intervalMs` (start to start; `retryMs`
 *   after a refresh that failed), never two at once.
 * - Its own timer fences the holder `ttlMs - marginMs` after the last write
 *   that went through, whatever the refresh in flight is doing. Fenced means
 *   suspended: the app and Litestream are stopped (SIGSTOP), so nothing is
 *   written or uploaded, and the refreshes go on. If a write goes through
 *   again, nobody took the lease meanwhile, and they continue. If the lease
 *   turns out to be taken, they are killed and the process exits. Before
 *   there is anything to suspend, nothing happens: confirm() is the check
 *   that gates the start, and it retries an error that comes and goes.
 * - A handover keeps the refreshes going while the app stops: SIGTERM, then
 *   the app server alone is killed after `graceServerMs` (Litestream then
 *   makes its final sync), then everything after `graceGroupMs` more.
 *
 * The child (the app under Litestream) is attached once it runs, after the
 * restore and the migrations.
 *
 * @param {{
 *   lease: ReturnType<typeof createLease>,
 *   ttlMs?: number,
 *   marginMs?: number,
 *   intervalMs?: number,
 *   retryMs?: number,
 *   graceServerMs?: number,
 *   graceGroupMs?: number,
 *   now?: () => number,
 *   setTimer?: (run: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: any) => void,
 *   exit?: (code: number) => void,
 *   log?: (line: string) => void,
 * }} options
 */
export function holdLease({
  lease,
  ttlMs = 30_000,
  marginMs = 10_000,
  intervalMs = 5_000,
  retryMs = 1_000,
  graceServerMs = 15_000,
  graceGroupMs = 10_000,
  now = () => performance.now(),
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => clearTimeout(timer),
  exit = (code) => process.exit(code),
  log = () => {},
}) {
  /** @type {HeldChild | null} */
  let child = null;
  let stopped = false;
  let suspended = false;
  let handoverStarted = false;
  /** @type {unknown} */
  let timer = null;
  /** @type {unknown} */
  let fenceTimer = null;
  /** @type {unknown} */
  let graceTimer = null;
  /** @type {Promise<string>} */
  let queue = Promise.resolve("held");

  const lose = () => {
    stopped = true;
    log("the lease was taken by another instance; stopping now");
    child?.killGroup();
    exit(1);
  };

  const fence = () => {
    fenceTimer = null;

    if (stopped) {
      return;
    }

    if (!child) {
      // Nothing is replicated yet, and the check before it (confirm) is what
      // keeps a holder that lost the lease from starting. A restore or a
      // migration may block the loop for longer than the ttl on a healthy
      // lease, so this is no reason to stop.
      log(
        "the lease was not refreshed in time; it is checked before replicating",
      );
      return;
    }

    suspended = true;
    log("the lease could not be refreshed in time; suspending the database");
    child.suspend();
  };

  const armFence = () => {
    if (fenceTimer) {
      clearTimer(fenceTimer);
    }

    const written = lease.refreshedAt() ?? now();

    fenceTimer = setTimer(
      fence,
      Math.max(0, written + ttlMs - marginMs - now()),
    );
  };

  const runHandover = () => {
    if (!child) {
      return;
    }

    const running = child;

    log("a newer revision asked for the database; handing over");
    running.terminate();
    graceTimer = setTimer(() => {
      log("the app did not stop in time; killing its server");
      running.killServer();
      graceTimer = setTimer(() => {
        log("Litestream did not stop in time; killing it");
        running.killGroup();
      }, graceGroupMs);
    }, graceServerMs);
    void running.exited.then(() => {
      if (graceTimer) {
        clearTimer(graceTimer);
        graceTimer = null;
      }
    });
  };

  /** One refresh and what follows from it. Never throws. */
  const step = async () => {
    /** @type {string} */
    let state;

    try {
      state = await lease.heartbeat();
    } catch (error) {
      log(`lease refresh failed: ${describeError(error)}`);
      state = "failed";
    }

    if (stopped) {
      return state;
    }

    if (state === "lost") {
      lose();
      return state;
    }

    if (state === "failed") {
      return state;
    }

    armFence();

    if (suspended) {
      suspended = false;
      log("the lease is ours again; resuming the database");
      child?.resume();
    }

    if (state === "handover" && !handoverStarted) {
      handoverStarted = true;
      runHandover();
    }

    return state;
  };

  /** Steps never overlap: each one waits for the one before. */
  const enqueue = () => {
    queue = queue.then(step, step);
    return queue;
  };

  /** @param {number} delay */
  const schedule = (delay) => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }

    if (stopped) {
      return;
    }

    timer = setTimer(async () => {
      timer = null;

      const started = now();
      const state = await enqueue();

      schedule(
        state === "failed"
          ? retryMs
          : Math.max(0, intervalMs - (now() - started)),
      );
    }, delay);
  };

  armFence();
  schedule(intervalMs);

  return {
    /** Starts handling the app and Litestream, once they are running. */
    attach(/** @type {HeldChild} */ running) {
      child = running;

      if (handoverStarted) {
        runHandover();
      }
    },

    /**
     * One refresh now, which must be a write that went through. False when
     * it was not, or the lease was found taken.
     */
    async confirm() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }

      // A few tries, for an error that comes and goes.
      let state = await enqueue();

      for (let attempt = 0; attempt < 3 && state === "failed"; attempt += 1) {
        await new Promise((resolve) => {
          setTimer(() => resolve(undefined), retryMs * 2 ** attempt);
        });
        state = await enqueue();
      }

      schedule(intervalMs);

      return state === "held" || state === "handover";
    },

    /** Stops refreshing, after the refresh in flight. */
    async stop() {
      stopped = true;

      for (const pending of [timer, fenceTimer, graceTimer]) {
        if (pending) {
          clearTimer(pending);
        }
      }

      timer = null;
      fenceTimer = null;
      graceTimer = null;
      await queue;
    },
  };
}
