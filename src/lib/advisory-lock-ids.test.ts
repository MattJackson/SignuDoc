import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Every advisory lock names one critical section. Two sections that share
// a number would wait on each other, so each id is used once.

const SOURCE_ROOT = path.resolve(import.meta.dirname);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(full);
    }

    return /\.ts$/.test(entry.name) && !/\.(db)?test\.ts$/.test(entry.name)
      ? [full]
      : [];
  });
}

test("no two advisory locks share an id", () => {
  const owners = new Map<number, string[]>();
  const claim = (id: number, owner: string) =>
    owners.set(id, [...(owners.get(id) ?? []), owner]);

  // The migration runner holds a session lock from the same number space.
  const migrators = ["db/migrate.mjs", "db/sqlite/migrate.mjs"].map((file) =>
    path.resolve(SOURCE_ROOT, "../..", file),
  );

  for (const file of [...sourceFiles(SOURCE_ROOT), ...migrators]) {
    const text = readFileSync(file, "utf8");
    const names = new Map<string, number>();

    for (const match of text.matchAll(
      /^(?:export )?const ([A-Z_]*LOCK_ID) = (\d+);/gm,
    )) {
      const id = Number(match[2]);

      names.set(match[1]!, id);
      claim(id, `${path.relative(SOURCE_ROOT, file)} ${match[1]!}`);
    }

    // An id used as another's neighbour, such as BACKUP_RUN_LOCK_ID + 1.
    for (const match of text.matchAll(/\b([A-Z_]*LOCK_ID) \+ (\d+)/g)) {
      const base = names.get(match[1]!);

      if (base !== undefined) {
        claim(
          base + Number(match[2]),
          `${path.relative(SOURCE_ROOT, file)} ${match[1]!} + ${match[2]!}`,
        );
      }
    }
  }

  assert.ok(owners.size >= 8, "the lock ids were found");

  const shared = [...owners].filter(([, users]) => users.length > 1);

  assert.deepEqual(shared, []);
});
