import assert from "node:assert/strict";
import { test } from "node:test";

import { toLogLine } from "./logging.ts";

test("on Cloud Run each line says its severity, for Cloud Logging", () => {
  const onCloudRun = { K_SERVICE: "signudoc" };

  assert.equal(
    JSON.parse(toLogLine({ level: "error", type: "security" }, onCloudRun))
      .severity,
    "ERROR",
  );
  assert.equal(
    JSON.parse(toLogLine({ level: "warn", type: "security" }, onCloudRun))
      .severity,
    "WARNING",
  );
  assert.equal(
    JSON.parse(
      toLogLine({ level: "info", type: "audit" }, { CLOUD_RUN_JOB: "migrate" }),
    ).severity,
    "INFO",
  );
});

test("anywhere else the line is as it always was", () => {
  const line = JSON.parse(
    toLogLine({ level: "error", type: "security" }, { VERCEL: "1" }),
  ) as Record<string, unknown>;

  assert.equal("severity" in line, false);
  assert.equal(line.source, "signudoc");
  assert.equal(line.level, "error");
  assert.equal(line.type, "security");
});
