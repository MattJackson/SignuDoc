import assert from "node:assert/strict";
import { test } from "node:test";

import nextConfig from "../../next.config.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "./types/domain.ts";

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

function toBytes(size: number | string | undefined): number | null {
  if (typeof size === "number") {
    return size;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(size?.trim() ?? "");

  return match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : null;
}

test("the proxy passes on an upload of the largest allowed size whole", () => {
  // Next.js cuts a body off at 10 MB when this is unset. The form around
  // the file needs some room too.
  const limit = toBytes(nextConfig.experimental?.proxyClientMaxBodySize);

  assert.ok(limit !== null, "proxyClientMaxBodySize is set");
  assert.ok(limit >= MAX_UPLOAD_SIZE_BYTES + 1024 * 1024);
});
