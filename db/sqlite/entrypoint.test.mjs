import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "entrypoint.sh",
);

/** Runs the entrypoint with a stand-in for node that prints its arguments. */
function started(databaseUrl) {
  const directory = mkdtempSync(path.join(tmpdir(), "signudoc-entrypoint-"));

  try {
    writeFileSync(path.join(directory, "node"), '#!/bin/sh\necho "$@"\n', {
      mode: 0o755,
    });

    const result = spawnSync("sh", [entrypoint], {
      encoding: "utf8",
      env: { DATABASE_URL: databaseUrl, PATH: `${directory}:/usr/bin:/bin` },
    });

    return result.stdout.trim();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("a sqlite: URL starts through the SQLite start script, however it is written", () => {
  for (const url of [
    "sqlite:/data/x.db",
    "SQLITE:/data/x.db",
    "Sqlite:/data/x.db",
    "  sqlite:/data/x.db",
    " Sqlite:/tmp/x.db",
  ]) {
    assert.equal(started(url), "db/sqlite/start.mjs", JSON.stringify(url));
  }
});

test("anything else starts the server directly", () => {
  assert.equal(started("postgres://a@b/c"), "server.js");
  assert.equal(started(""), "server.js");
});
