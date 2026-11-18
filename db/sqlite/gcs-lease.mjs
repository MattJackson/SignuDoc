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
 * The lease object in Cloud Storage, through the JSON API. `write` and
 * `remove` return null / false when the precondition fails.
 *
 * @param {{ bucket: string, object: string, getToken: () => Promise<string>,
 *   fetch?: typeof fetch }} options
 * @returns {LeaseStorage}
 */
export function gcsLeaseStorage({
  bucket,
  object,
  getToken,
  fetch = globalThis.fetch,
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
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Reading the lease failed: ${String(response.status)}`);
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
        },
      );

      if (response.status === 412) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Writing the lease failed: ${String(response.status)}`);
      }

      const written = /** @type {{ generation: string }} */ (
        await response.json()
      );

      return String(written.generation);
    },
    async remove(ifGeneration) {
      const response = await fetch(
        `${base}/storage/v1/b/${bucket}/o/${name}?ifGenerationMatch=${ifGeneration}`,
        { headers: await headers(), method: "DELETE" },
      );

      if (response.status === 412 || response.status === 404) {
        return false;
      }

      if (!response.ok) {
        throw new Error(
          `Releasing the lease failed: ${String(response.status)}`,
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
 * @returns {() => Promise<string>}
 */
export function metadataServerToken(fetchImpl = globalThis.fetch) {
  /** @type {{ token: string, until: number } | null} */
  let cached = null;

  return async () => {
    if (cached && cached.until > Date.now()) {
      return cached.token;
    }

    const response = await fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "metadata-flavor": "Google" } },
    );

    if (!response.ok) {
      throw new Error(
        `The metadata server gave no token: ${String(response.status)}`,
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

/**
 * @param {{
 *   storage: LeaseStorage,
 *   holder: string,
 *   revision: string,
 *   ttlMs?: number,
 *   pollMs?: number,
 *   now?: () => number,
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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  /** @type {string | null} */
  let generation = null;
  const body = () => ({
    heartbeatAt: new Date(now()).toISOString(),
    holder,
    revision,
  });

  return {
    /** Waits until this instance holds the lease. */
    async acquire() {
      let reported = false;

      for (;;) {
        const current = await storage.read();

        if (!current) {
          generation = await storage.write(body(), "0");

          if (generation) {
            log("[lease] taken");
            return;
          }

          continue;
        }

        const age = now() - Date.parse(current.body.heartbeatAt);

        if (current.body.holder === holder || !(age < ttlMs)) {
          generation = await storage.write(body(), current.generation);

          if (generation) {
            log(
              current.body.holder === holder
                ? "[lease] taken back"
                : `[lease] taken over from ${current.body.holder}, silent for ${String(Math.round(age / 1000))} s`,
            );
            return;
          }

          continue;
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

        await sleep(pollMs);
      }
    },

    /**
     * Refreshes the lease. "held" while it is still ours, "handover" when a
     * newer revision has asked for it, "lost" when someone else has it.
     *
     * @returns {Promise<"held" | "handover" | "lost">}
     */
    async heartbeat() {
      if (!generation) {
        return "lost";
      }

      const refreshed = await storage.write(body(), generation);

      if (refreshed) {
        generation = refreshed;
        return "held";
      }

      const current = await storage.read();

      if (!current || current.body.holder !== holder) {
        generation = null;
        return "lost";
      }

      generation = current.generation;

      if (
        current.body.handoverTo &&
        revisionNumber(current.body.handoverTo.revision) >
          revisionNumber(revision)
      ) {
        return "handover";
      }

      return "held";
    },

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
