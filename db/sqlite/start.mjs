#!/usr/bin/env node
// Starts the app in the Docker image on the SQLite backend (DATABASE_URL is
// a sqlite: URL; db/sqlite/entrypoint.sh decides). See
// docs/design/database-backends.md, "Durability on Cloud Run with
// Litestream".
//
// With LITESTREAM_REPLICA_URL (gs://bucket/path, or file:///path):
//   1. on Cloud Storage, take the lease, so only one instance writes;
//   2. restore the database from the replica, unless it is already here;
//   3. run the migrations;
//   4. litestream replicate -exec "node server.js": every commit is copied
//      to the replica within about a second, and on SIGTERM the server stops
//      first and Litestream syncs what is left before it exits.
// Without it: run the migrations and start the server.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";

import { runMigrations } from "../migrate.mjs";
import {
  createLease,
  gcsLeaseStorage,
  holdLease,
  metadataServerToken,
} from "./gcs-lease.mjs";
import { sqliteFilePath } from "./open.mjs";

const CONFIG_PATH = "/tmp/litestream.yml";
const SERVER_PID_FILE = "/tmp/signudoc-server.pid";

function log(line) {
  console.log(`[start] ${line}`);
}

/** Runs a command to its end; rejects on a non-zero exit. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve(undefined)
        : reject(
            new Error(
              `${command} ${args[0] ?? ""} exited with ${signal ?? String(code)}`,
            ),
          ),
    );
  });
}

/** Starts a long-running command, passing SIGTERM and SIGINT on to it. */
function supervise(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }

  return {
    child,
    exited: new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))),
    ),
  };
}

/**
 * Litestream with the app under it, in a process group of their own so that
 * the whole group can be stopped, suspended or killed at once. The app writes
 * its process id to a file, which lets a handover kill the app server alone
 * and leave Litestream to make its final sync. `exited` resolves once the
 * group is gone, so that the lease is not given up while something in it can
 * still write.
 */
function superviseReplicator() {
  rmSync(SERVER_PID_FILE, { force: true });

  const child = spawn(
    "litestream",
    [
      "replicate",
      "-config",
      CONFIG_PATH,
      "-exec",
      `sh -c 'echo $$ > ${SERVER_PID_FILE}; exec node server.js'`,
    ],
    { detached: true, stdio: "inherit" },
  );
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }

  return {
    exited: new Promise((resolve) =>
      child.on("exit", async (code, signal) => {
        // Anything Litestream left behind goes now.
        signalGroup("SIGKILL");

        for (let wait = 0; wait < 30 && signalGroup(0); wait += 1) {
          await new Promise((done) => setTimeout(done, 100));
        }

        resolve(code ?? (signal ? 1 : 0));
      }),
    ),
    killGroup: () => signalGroup("SIGKILL"),
    killServer: () => {
      try {
        process.kill(
          Number(readFileSync(SERVER_PID_FILE, "utf8").trim()),
          "SIGKILL",
        );
      } catch {
        // Not started, or gone already.
      }
    },
    resume: () => signalGroup("SIGCONT"),
    suspend: () => signalGroup("SIGSTOP"),
    terminate: () => child.kill("SIGTERM"),
  };
}

export function litestreamConfig({ file, replicaUrl, env = process.env }) {
  const lines = [
    "# Written by db/sqlite/start.mjs at container start.",
    // Cloud Run allows 10 s after SIGTERM: the server stops, then the last
    // changes are synced, within that.
    `shutdown-sync-timeout: ${env.LITESTREAM_SHUTDOWN_SYNC_TIMEOUT ?? "6s"}`,
    "snapshot:",
    `  interval: ${env.LITESTREAM_SNAPSHOT_INTERVAL ?? "24h"}`,
    `  retention: ${env.LITESTREAM_RETENTION ?? "168h"}`,
    "dbs:",
    `  - path: ${JSON.stringify(file)}`,
    "    replica:",
    `      url: ${JSON.stringify(replicaUrl)}`,
    `      sync-interval: ${env.LITESTREAM_SYNC_INTERVAL ?? "1s"}`,
    "",
  ];

  return lines.join("\n");
}

/** Where the lease object goes: beside the replica, gs://bucket/db.lease. */
export function leaseLocation(replicaUrl) {
  const url = new URL(replicaUrl);

  if (url.protocol !== "gs:") {
    return null;
  }

  const path = url.pathname.replace(/^\/+|\/+$/g, "");

  return { bucket: url.hostname, object: `${path || "litestream"}.lease` };
}

/**
 * Until the app can listen, the port answers so Cloud Run counts the instance
 * as started and moves traffic to it (which is what makes the old revision
 * stop): /api/health says yes, anything else says to come back shortly. It
 * stays up through the restore and the migrations, and is closed just before
 * the app starts.
 */
function startWaitingServer() {
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/health")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"starting"}');
      return;
    }

    response.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "5",
    });
    response.end("Starting up. Try again in a few seconds.\n");
  });

  server.listen(port, process.env.HOSTNAME ?? "0.0.0.0");

  // An open connection would keep close() waiting, and the port must be free
  // for the app.
  return () =>
    new Promise((resolve) => {
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });
}

/**
 * Starts the app under the lease: the waiting server answers until the
 * database is restored, migrated and the lease confirmed; the lease is kept
 * fresh from the moment it is taken; and it is given back if starting fails
 * or when the app has stopped. The steps are passed in so that they can be
 * tested.
 *
 * Resolves with the exit code of the app.
 */
export async function startWithLease({
  lease,
  startWaiting,
  restore,
  migrate,
  replicate,
  holdOptions = {},
  log: say = log,
}) {
  const stopWaiting = startWaiting();
  let stoppedWaiting = null;
  const closeWaiting = () => (stoppedWaiting ??= stopWaiting());
  let held = null;

  try {
    await lease.acquire();
    held = holdLease({ lease, log: say, ...holdOptions });
    await restore();
    await migrate();

    // A migration blocks the event loop, so the refreshes and the fence may
    // not have run. Nothing has been copied to the replica yet: be sure the
    // lease is still ours before the first thing is.
    if (!(await held.confirm())) {
      throw new Error("The lease could not be confirmed before replicating.");
    }

    await closeWaiting();
  } catch (error) {
    await closeWaiting().catch(() => undefined);
    await held?.stop();
    await lease
      .release()
      .catch((releaseError) =>
        say(`releasing the lease failed: ${String(releaseError)}`),
      );
    throw error;
  }

  const child = replicate();

  held.attach(child);

  const code = await child.exited;

  await held.stop();
  // Litestream has made its last sync and the group is gone, so the next
  // instance can have the database.
  await lease
    .release()
    .catch((error) => say(`releasing the lease failed: ${String(error)}`));

  return code;
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? "";
  const file = sqliteFilePath(connectionString);
  const replicaUrl = process.env.LITESTREAM_REPLICA_URL?.trim();

  if (!replicaUrl) {
    log("no LITESTREAM_REPLICA_URL: the database is not replicated");
    await runMigrations({ connectionString });
    process.exitCode = await supervise("node", ["server.js"]).exited;
    return;
  }

  writeFileSync(CONFIG_PATH, litestreamConfig({ file, replicaUrl }));

  const location = leaseLocation(replicaUrl);
  const leaseWanted = location && process.env.LITESTREAM_LEASE !== "off";
  const restore = () => {
    log(`restoring ${file} from ${replicaUrl}, if it is not here already`);
    return run("litestream", [
      "restore",
      "-config",
      CONFIG_PATH,
      "-if-db-not-exists",
      "-if-replica-exists",
      file,
    ]);
  };
  const migrate = () => runMigrations({ connectionString });

  if (!leaseWanted) {
    await restore();
    await migrate();
    process.exitCode = await superviseReplicator().exited;
    return;
  }

  process.exitCode = await startWithLease({
    lease: createLease({
      holder: `${hostname()}-${String(process.pid)}-${String(Date.now())}`,
      log,
      revision: process.env.K_REVISION ?? "local-00000-x",
      storage: gcsLeaseStorage({
        ...location,
        getToken: metadataServerToken(),
      }),
    }),
    migrate,
    replicate: superviseReplicator,
    restore,
    startWaiting: startWaitingServer,
  });
}

const invokedDirectly = process.argv[1]?.endsWith("start.mjs");

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[start] failed:", error);
    process.exit(1);
  });
}
