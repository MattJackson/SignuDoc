import assert from "node:assert/strict";
import { test } from "node:test";

import { DocumentImportError } from "../services/document-import.ts";
import {
  describeFilesProblem,
  describeImportFailure,
  draftTitleFromFileName,
  openConnectState,
  safeReturnPath,
  sealConnectState,
  withFilesProblem,
} from "./files.ts";
import { FileImportError, FilesConnectionError } from "./types.ts";

// The app's side of starting an envelope from a workspace file: the state
// kept while the person is at the provider, where they may be sent back
// to, and what they are told.

const env = { BETTER_AUTH_SECRET: "s".repeat(40) };

test("the state cookie opens only unchanged, with the same secret, and while fresh", () => {
  const value = {
    createdAt: 1_800_000_000,
    returnTo: "/envelopes/new/files",
    secret: "verifier-1",
    state: "state-1",
    userId: "user-1",
  };
  const sealed = sealConnectState(value, env);

  assert.deepEqual(openConnectState(sealed, env, 1_800_000_100), value);
  assert.equal(
    openConnectState(`${sealed.slice(0, -4)}AAAA`, env, 1_800_000_100),
    null,
  );
  assert.equal(
    openConnectState(
      sealed,
      { BETTER_AUTH_SECRET: "t".repeat(40) },
      1_800_000_100,
    ),
    null,
  );
  assert.equal(openConnectState(sealed, env, 1_800_000_000 + 11 * 60), null);
  assert.equal(openConnectState(null, env), null);
});

test("only a path on this site is a place to return to", () => {
  assert.equal(safeReturnPath("/settings#files"), "/settings#files");
  assert.equal(safeReturnPath("//evil.example"), "/envelopes/new/files");
  assert.equal(safeReturnPath("https://evil.example"), "/envelopes/new/files");
  assert.equal(safeReturnPath("/\\evil.example"), "/envelopes/new/files");
  assert.equal(safeReturnPath("/a b"), "/envelopes/new/files");
  assert.equal(safeReturnPath(null), "/envelopes/new/files");
});

test("a problem code is added to the path and only known codes are shown", () => {
  assert.equal(
    withFilesProblem("/settings?x=1", "denied"),
    "/settings?x=1&files=denied",
  );
  assert.match(describeFilesProblem("wrong_account") ?? "", /account/);
  assert.equal(describeFilesProblem("<script>"), null);
  assert.equal(describeFilesProblem("toString"), null);
});

test("an import says what the person can fix, and nothing else", () => {
  assert.deepEqual(describeImportFailure(new FileImportError("Too large.")), {
    connect: false,
    message: "Too large.",
    status: 400,
  });
  assert.equal(
    describeImportFailure(new DocumentImportError("unreadable_pdf"))?.status,
    400,
  );
  assert.deepEqual(
    describeImportFailure(
      new FilesConnectionError("not_connected", "Connect first."),
    ),
    {
      connect: true,
      message: "Connect your files, then try again.",
      status: 409,
    },
  );
  // A provider outage is not a reason to reconnect.
  assert.equal(
    describeImportFailure(new FilesConnectionError("failed", "Unreachable.")),
    null,
  );
  assert.equal(describeImportFailure(new Error("boom")), null);
});

test("a draft's title comes from the file's name", () => {
  assert.equal(draftTitleFromFileName("Offer_letter.pdf"), "Offer letter");
  assert.equal(draftTitleFromFileName(".pdf"), "Untitled document");
});
