import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { resolveLocalStorageRoot } from "./local.ts";

test("an empty STORAGE_LOCAL_DIR is reported once, naming the folder now used", () => {
  const warn = mock.method(console, "warn", () => undefined);

  try {
    resolveLocalStorageRoot({ STORAGE_LOCAL_DIR: "  " });
    resolveLocalStorageRoot({ STORAGE_LOCAL_DIR: "" });
    resolveLocalStorageRoot({});

    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /STORAGE_LOCAL_DIR/);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /\.data\/storage/);
  } finally {
    warn.mock.restore();
  }
});
