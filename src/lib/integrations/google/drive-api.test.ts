import assert from "node:assert/strict";
import { test } from "node:test";

import { DriveApiError, driveFetch } from "./drive-api.ts";

// A Drive request that Google never answers is given up on, so it cannot
// hold its caller for minutes.

/** Rejects when the test hangs, so a missing deadline fails instead of stalling. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("The request was still waiting after the deadline."));
    }, ms);
  });

  return Promise.race([promise, hung]).finally(() => {
    clearTimeout(timer);
  });
}

test("a Drive request with no answer ends with a could-not-be-reached error", async () => {
  let signal: AbortSignal | null | undefined;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;

    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    });
  }) as typeof fetch;

  await assert.rejects(
    within(
      driveFetch(
        fetchImpl,
        "token",
        "Reading a file",
        "https://www.googleapis.com/drive/v3/files/1",
        {},
        20,
      ),
      2000,
    ),
    (error) => error instanceof DriveApiError && error.status === null,
  );
  assert.ok(signal);
});
