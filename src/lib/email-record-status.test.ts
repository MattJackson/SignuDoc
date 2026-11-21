import assert from "node:assert/strict";
import test from "node:test";

import { describeRecordStatus } from "./email-record-status.ts";

test("a verified record is found, a failed one is not waiting to appear", () => {
  assert.equal(describeRecordStatus("verified"), "Found");
  assert.notEqual(describeRecordStatus("failed"), "Not found yet");
  assert.notEqual(describeRecordStatus("temporary_failure"), "Not found yet");
  assert.equal(describeRecordStatus("pending"), "Not found yet");
  assert.equal(describeRecordStatus("not_started"), "Not found yet");
});
