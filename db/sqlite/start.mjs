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
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";

import { runMigrations } from "../migrate.mjs";
import {
  createLease,
  gcsLeaseStorage,
  metadataServerToken,
} from "./gcs-lease.mjs";
import { sqliteFilePath } from "./open.mjs";

const CONFIG_PATH = "/tmp/litestream.yml";
const HEARTBEAT_MS = 10_000;

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
 * Until the lease is ours, the port answers so Cloud Run counts the instance
 * as started and moves traffic to it (which is what makes the old revision
 * stop): /api/health says yes, anything else says to come back shortly.
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

  return () => new Promise((resolve) => server.close(() => resolve(undefined)));
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
  const lease = leaseWanted
    ? createLease({
        holder: `${hostname()}-${String(process.pid)}-${String(Date.now())}`,
        log,
        revision: process.env.K_REVISION ?? "local-00000-x",
        storage: gcsLeaseStorage({
          ...location,
          getToken: metadataServerToken(),
        }),
      })
    : null;

  if (lease) {
    const stopWaiting = startWaitingServer();

    try {
      await lease.acquire();
    } finally {
      await stopWaiting();
    }
  }

  log(`restoring ${file} from ${replicaUrl}, if it is not here already`);
  await run("litestream", [
    "restore",
    "-config",
    CONFIG_PATH,
    "-if-db-not-exists",
    "-if-replica-exists",
    file,
  ]);
  await runMigrations({ connectionString });

  const { child, exited } = supervise("litestream", [
    "replicate",
    "-config",
    CONFIG_PATH,
    "-exec",
    "node server.js",
  ]);
  let heartbeat = null;

  if (lease) {
    heartbeat = setInterval(() => {
      lease
        .heartbeat()
        .then((state) => {
          if (state === "lost") {
            // Someone else writes the database now: stop without another write.
            log("the lease was taken by another instance; stopping now");
            child.kill("SIGKILL");
            process.exit(1);
          }

          if (state === "handover") {
            log("a newer revision asked for the database; handing over");
            clearInterval(heartbeat);
            child.kill("SIGTERM");
          }
        })
        .catch((error) => log(`lease refresh failed: ${String(error)}`));
    }, HEARTBEAT_MS);
  }

  const code = await exited;

  if (heartbeat) {
    clearInterval(heartbeat);
  }

  // Litestream has made its last sync by now, so the next instance can have it.
  await lease
    ?.release()
    .catch((error) => log(`releasing the lease failed: ${String(error)}`));
  process.exitCode = code;
}

const invokedDirectly = process.argv[1]?.endsWith("start.mjs");

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[start] failed:", error);
    process.exit(1);
  });
}
