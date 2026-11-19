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
if [ -n "\${STUB_NOTYET:-}" ] && [[ "$*" == *"$STUB_NOTYET"* ]]; then
  seen=$(cat "$STUB_LOG.count" 2>/dev/null || echo 0)
  echo $((seen + 1)) > "$STUB_LOG.count"
  if [ "$seen" -lt "\${STUB_NOTYET_TIMES:-2}" ]; then
    echo "\${STUB_NOTYET_MESSAGE:-ERROR: (gcloud) INVALID_ARGUMENT: Service account signudoc-run does not exist.}" >&2
    exit 1
  fi
fi
if [[ "$*" == *"jobs list"* ]]; then printf '%s' "\${STUB_JOBS:-}"; fi
if [[ "$*" == *"versions add"* ]]; then cat > /dev/null; fi
for arg in "$@"; do
  if [[ "$arg" == --lifecycle-file=* ]]; then cat "\${arg#--lifecycle-file=}" >> "$STUB_LOG"; echo >> "$STUB_LOG"; fi
done
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
        NODE_ENV: "test",
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

test("setup.sh deletes noncurrent versions in the replica and backup buckets", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    BACKUP_REGION: "europe-west1",
    DB_BACKEND: "sqlite",
  });

  assert.equal(status, 0);

  for (const [bucket, days] of [
    ["test-project-signudoc-db", 7],
    ["test-project-signudoc-backups", 30],
  ] as const) {
    const lines = calls.split("\n");
    const at = lines.findIndex((line) =>
      line.includes(`storage buckets update gs://${bucket} --lifecycle-file=`),
    );

    assert.notEqual(at, -1, `${bucket} has a lifecycle rule`);
    assert.deepEqual(JSON.parse(lines[at + 1] ?? ""), {
      rule: [
        {
          action: { type: "Delete" },
          condition: { daysSinceNoncurrentTime: days, isLive: false },
        },
      ],
    });
  }
});

const RUNTIME_BINDING =
  "add-iam-policy-binding signudoc-run@test-project.iam.gserviceaccount.com";

function bindingCalls(calls: string) {
  return calls
    .split("\n")
    .filter((line) => line.includes(`${RUNTIME_BINDING} --member=`)).length;
}

test("setup.sh retries a binding while the new service account is not there yet", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    SA_RETRY_SLEEP: "0",
    STUB_NOTYET: RUNTIME_BINDING,
    STUB_NOTYET_TIMES: "3",
  });

  assert.equal(status, 0);
  // Three refusals, then the binding that took.
  assert.ok(bindingCalls(calls) >= 4, calls);
});

test("setup.sh gives up when the service account never appears", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    SA_RETRY_SLEEP: "0",
    STUB_NOTYET: RUNTIME_BINDING,
    STUB_NOTYET_TIMES: "1000",
  });

  assert.notEqual(status, 0);
  assert.equal(bindingCalls(calls), 18);
  assert.doesNotMatch(calls, /run deploy/);
});

test("setup.sh does not retry a binding that fails for any other reason", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    SA_RETRY_SLEEP: "0",
    STUB_FAIL: RUNTIME_BINDING,
  });

  assert.notEqual(status, 0);
  assert.equal(bindingCalls(calls), 1);
});

test("setup.sh retries the deploy service account's bindings too", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    GITHUB_REPOSITORY: "acme/signudoc",
    SA_RETRY_SLEEP: "0",
    STUB_NOTYET: "add-iam-policy-binding signudoc-deploy@test-project",
    STUB_NOTYET_TIMES: "2",
  });

  assert.equal(status, 0);
  assert.match(calls, /run deploy signudoc /);
});

test("setup.sh also retries the NOT_FOUND form of the error", () => {
  const { calls, status } = runScript("deploy/google-cloud/setup.sh", {
    SA_RETRY_SLEEP: "0",
    STUB_NOTYET: RUNTIME_BINDING,
    STUB_NOTYET_MESSAGE: "ERROR: (gcloud) NOT_FOUND: Unknown service account",
    STUB_NOTYET_TIMES: "2",
  });

  assert.equal(status, 0);
  assert.ok(bindingCalls(calls) >= 3, calls);
});
