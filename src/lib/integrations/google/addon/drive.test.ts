import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadDriveFile, DriveApiError } from "./drive.ts";

// Reading a Drive file for the add-on never holds more than the limit.

test("a file with no stated size is refused once it passes the limit, without reading it all", async () => {
  const chunks = 200;
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();

        return;
      }

      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const fetchImpl = (async () => new Response(body)) as typeof fetch;

  await assert.rejects(
    downloadDriveFile("file-1", "token", fetchImpl, 4096),
    (error) => error instanceof DriveApiError && error.status === 413,
  );
  assert.ok(cancelled, "the stream is cancelled once it passes the limit");
  assert.ok(
    pulled < chunks,
    `only part of the body is read (${String(pulled)})`,
  );
});

test("a file within the limit is read in full", async () => {
  const fetchImpl = (async () =>
    new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;

  assert.deepEqual(
    [...(await downloadDriveFile("file-1", "token", fetchImpl, 4096))],
    [1, 2, 3],
  );
});
