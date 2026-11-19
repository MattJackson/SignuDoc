import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "./route.ts";

test("the health check answers ok without being cached", async () => {
  const response = GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});
