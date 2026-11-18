#!/usr/bin/env node
// Copies what db/migrate.mjs needs at runtime (the pg package and
// everything it depends on, as locked in package-lock.json) into a Next.js
// standalone build, so the Docker image can run migrations as well as the
// app. Next.js only copies the files the app itself was traced to use.
//
//   node scripts/copy-migrate-packages.mjs .next/standalone
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];

if (!target) {
  console.error(
    "Usage: node scripts/copy-migrate-packages.mjs <standalone dir>",
  );
  process.exit(1);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = lock.packages ?? {};
const wanted = new Set();

function visit(name) {
  const entry = packages[`node_modules/${name}`];

  if (wanted.has(name) || !entry) {
    return;
  }

  wanted.add(name);

  for (const dependency of Object.keys({
    ...entry.dependencies,
    ...entry.optionalDependencies,
  })) {
    visit(dependency);
  }
}

visit("pg");

for (const name of [...wanted].sort()) {
  const source = path.join("node_modules", name);

  if (!existsSync(source)) {
    // An optional dependency that was not installed on this platform.
    continue;
  }

  cpSync(source, path.join(target, "node_modules", name), {
    dereference: true,
    recursive: true,
  });
  console.log(`[docker] copied ${name} for db/migrate.mjs`);
}
