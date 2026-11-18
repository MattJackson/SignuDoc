import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDriveProblem } from "./drive-problems.ts";
import { MAX_CONVERT_SOURCE_BYTES } from "./integrations/google/convert.ts";

test("the too-large message on the new-envelope page names the conversion limit", () => {
  assert.match(
    describeDriveProblem("too_large") ?? "",
    new RegExp(`${String(MAX_CONVERT_SOURCE_BYTES / (1024 * 1024))} MB`),
  );
});
