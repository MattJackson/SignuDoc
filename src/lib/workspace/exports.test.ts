import assert from "node:assert/strict";
import { test } from "node:test";

import {
  afterFailedAttempt,
  buildExportMetadata,
  DEFAULT_EXPORT_FOLDER_PATTERN,
  findCounterparty,
  MAX_EXPORT_ATTEMPTS,
  nextAttemptDelaySeconds,
  renderExportPath,
  validateFolderPattern,
} from "./exports.ts";

// The copy of completed envelopes, apart from the database: the retry
// schedule, the folder layout and the metadata a provider may attach.

test("the wait between tries doubles from five minutes, up to twelve hours", () => {
  assert.equal(nextAttemptDelaySeconds(1), 5 * 60);
  assert.equal(nextAttemptDelaySeconds(2), 10 * 60);
  assert.equal(nextAttemptDelaySeconds(3), 20 * 60);
  assert.equal(nextAttemptDelaySeconds(20), 12 * 60 * 60);
});

test("a failure waits, until the last try, which gives up", () => {
  assert.deepEqual(afterFailedAttempt(1, 1000), {
    nextAttemptAt: 1300,
    status: "pending",
  });
  assert.equal(
    afterFailedAttempt(MAX_EXPORT_ATTEMPTS - 1, 1000).status,
    "pending",
  );
  assert.equal(afterFailedAttempt(MAX_EXPORT_ATTEMPTS, 1000).status, "failed");
  assert.equal(afterFailedAttempt(1, 1000, true).status, "failed");
});

test("the folder layout: folders, then the file name, with the date in UTC", () => {
  const completedAt = Date.UTC(2026, 0, 31, 23, 30) / 1000;

  assert.deepEqual(
    renderExportPath(DEFAULT_EXPORT_FOLDER_PATTERN, {
      completedAt,
      envelopeId: "3f2a9c1e-1111-4000-8000-000000000000",
      title: "Lease / Unit 4",
    }),
    ["2026", "2026-01-31 — Lease - Unit 4 — 3f2a9c1e"],
  );
  assert.deepEqual(
    renderExportPath("{yyyy-MM}/{senderEmail}/../{unknown}", {
      completedAt,
      envelopeId: "e",
      senderEmail: "sam@example.com",
      title: "T",
    }),
    ["2026-01", "sam@example.com", "{unknown}"],
  );
  assert.equal(
    renderExportPath("", { completedAt, envelopeId: "e", title: "T" }).length,
    2,
  );
});

test("a layout that ends with a slash or is too long is refused", () => {
  assert.equal(validateFolderPattern(DEFAULT_EXPORT_FOLDER_PATTERN), null);
  assert.match(validateFolderPattern("{yyyy}/") ?? "", /slash/);
  assert.match(validateFolderPattern("x".repeat(301)) ?? "", /300/);
});

test("the counterparty is the first signer outside the sender's domain", () => {
  const signers = [
    { email: "manager@example.com", name: "Manager", role: "signer" },
    { email: "cc@outside.example", name: "Copy", role: "cc" },
    { email: "pat@customer.example", name: "Pat", role: "signer" },
    { email: "lee@other.example", name: "Lee", role: "signer" },
  ];

  assert.deepEqual(findCounterparty(signers, "sam@example.com"), {
    email: "pat@customer.example",
    name: "Pat",
  });
  assert.equal(findCounterparty(signers.slice(0, 2), "sam@example.com"), null);
});

test("the metadata is formatted for any provider", () => {
  assert.deepEqual(
    buildExportMetadata({
      completedAt: Date.UTC(2026, 10, 17, 12) / 1000,
      counterparty: { email: "pat@customer.example", name: null },
      envelopeId: "env-1",
      senderEmail: "sam@example.com",
      senderName: " ",
      title: "Lease",
    }),
    {
      completedDate: "2026-11-17",
      counterparty: "pat@customer.example",
      counterpartyEmail: "pat@customer.example",
      envelopeId: "env-1",
      senderEmail: "sam@example.com",
      senderName: null,
      title: "Lease",
    },
  );
});
