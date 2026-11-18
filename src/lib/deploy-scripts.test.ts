import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Checks on the deploy scripts and workflows, which have no other tests:
// the shell scripts run against a stand-in gcloud that records its calls.

const root = path.resolve(import.meta.dirname, "../..");

function read(file: string) {
  return readFileSync(path.join(root, file), "utf8");
}

const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL:-}" ] && [[ "$*" == *"$STUB_FAIL"* ]]; then
  echo "stub failure" >&2
  exit 1
fi
if [[ "$*" == *"jobs list"* ]]; then printf '%s' "\${STUB_JOBS:-}"; fi
if [[ "$*" == *"versions add"* ]]; then cat > /dev/null; fi
exit 0
`;

function runScript(
  script: string,
  extraEnv: Record<string, string>,
): { calls: string; status: number | null } {
  const dir = mkdtempSync(path.join(tmpdir(), "signudoc-stub-"));

  try {
    const log = path.join(dir, "calls.log");

    writeFileSync(log, "");
    writeFileSync(path.join(dir, "gcloud"), STUB);
    chmodSync(path.join(dir, "gcloud"), 0o755);

    const result = spawnSync("bash", [path.join(root, script)], {
      encoding: "utf8",
      env: {
        HOME: dir,
        IMAGE: "registry/signudoc@sha256:abc",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        PROJECT_ID: "test-project",
        STUB_LOG: log,
        ...extraEnv,
      },
    });

    return { calls: readFileSync(log, "utf8"), status: result.status };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("MISC-12: deploy.sh stops when it cannot tell whether the migrate job exists", () => {
  const { calls, status } = runScript("deploy/google-cloud/deploy.sh", {
    STUB_FAIL: "jobs list",
  });

  assert.notEqual(status, 0);
  assert.doesNotMatch(calls, /services update/);
});

test("MISC-12: deploy.sh picks sqlite when no migrate job is listed", () => {
  const { calls, status } = runScript("deploy/google-cloud/deploy.sh", {});

  assert.equal(status, 0);
  assert.doesNotMatch(calls, /jobs execute/);
  assert.match(calls, /services update/);
});

test("MISC-12: deploy.sh picks postgres when the migrate job is listed", () => {
  const { calls, status } = runScript("deploy/google-cloud/deploy.sh", {
    STUB_JOBS: "signudoc-migrate",
  });

  assert.equal(status, 0);
  assert.match(calls, /jobs execute signudoc-migrate/);
});

test("MISC-13: setup.sh does not write a new secret when it cannot read the versions", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    STUB_FAIL: "secrets versions list",
  });

  assert.notEqual(status, 0);
  assert.doesNotMatch(
    calls,
    /secrets versions add signudoc-better-auth-secret/,
  );
});

test("MISC-13: setup.sh generates a secret once when it has no version", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {});
  const added = calls
    .split("\n")
    .filter((line) =>
      line.includes("versions add signudoc-better-auth-secret"),
    );

  assert.equal(status, 0);
  assert.equal(added.length, 1);
});

test("MISC-3: the sync workflow starts CI for its branch, and CI can be started", () => {
  const sync = read(".github/workflows/sync-upstream.yml");
  const ci = read(".github/workflows/ci.yml");

  assert.match(sync, /gh workflow run ci\.yml/);
  assert.match(sync, /actions: write/);
  assert.match(ci, /^ {2}workflow_dispatch:/m);
});

test("MISC-4: the SQLite deploy only sets the backup bucket when one is configured", () => {
  const workflow = read(".github/workflows/deploy-cloud-run.yml");
  const line = workflow
    .split("\n")
    .findIndex((text) => text.includes("BACKUP_GCS_BUCKET="));

  assert.ok(line > 0);
  assert.match(workflow.split("\n")[line - 1]!, /if \[ -n "\$\{?BACKUP_BUCKET/);
  assert.match(workflow, /vars\.BACKUP_BUCKET/);
  assert.match(workflow, /vars\.FILES_BUCKET/);
  assert.match(workflow, /vars\.DB_BUCKET/);
  assert.match(workflow, /vars\.SQLITE_PATH/);
});

test("MISC-5: the deploy workflow has no built-in site address", () => {
  const workflow = read(".github/workflows/deploy-cloud-run.yml");

  assert.doesNotMatch(workflow, /sign\.getbusbar\.com/);
  assert.match(workflow, /if \[ -n "\$\{?APP_URL/);
});

test("MISC-16: the sync workflow does not read a failed pr or issue list as empty", () => {
  const sync = read(".github/workflows/sync-upstream.yml");

  assert.doesNotMatch(sync, /gh pr list .*\|\| true/);
  assert.doesNotMatch(sync, /gh issue list .*\|\| true/);
});

test("MISC-10: the docs give the same retry schedule as setup.sh", () => {
  const docs = read("docs/google-cloud-run.md");

  assert.doesNotMatch(docs, /notifications every 15 minutes/);
  assert.doesNotMatch(docs, /wake it every 15 minutes by default/);
});
