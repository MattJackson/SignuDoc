import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLabelModification, type DriveLabel } from "./drive-labels.ts";

// Filling a Drive label's fields from an envelope's metadata.

const label: DriveLabel = {
  fields: [
    { id: "title", properties: { displayName: "Title" }, textOptions: {} },
    { id: "signed", dateOptions: {}, properties: { displayName: "Signed on" } },
    { id: "owner", properties: { displayName: "Owner" }, userOptions: {} },
    {
      id: "party",
      properties: { displayName: "Party" },
      selectionOptions: {
        choices: [
          { id: "c-acme", properties: { displayName: "Pat Customer" } },
          { id: "c-other", properties: { displayName: "Other" } },
        ],
      },
    },
    { id: "amount", integerOptions: {}, properties: { displayName: "Amount" } },
  ],
  id: "label-1",
};

const values = {
  completedDate: "2026-11-17",
  counterparty: "Pat Customer",
  counterpartyEmail: "pat@customer.example",
  envelopeId: "env-1",
  senderEmail: "sam@example.com",
  senderName: "Sam Sender",
  title: "Master services agreement",
};

test("each field gets the value of its kind", () => {
  const { fieldModifications, skipped } = buildLabelModification(
    label,
    {
      owner: "senderEmail",
      party: "counterparty",
      signed: "completedDate",
      title: "title",
    },
    values,
  );

  assert.deepEqual(fieldModifications, [
    { fieldId: "owner", setUserValues: ["sam@example.com"] },
    { fieldId: "party", setSelectionValues: ["c-acme"] },
    { fieldId: "signed", setDateValues: ["2026-11-17"] },
    { fieldId: "title", setTextValues: ["Master services agreement"] },
  ]);
  assert.deepEqual(skipped, []);
});

test("a value that does not fit its field is left out and said why", () => {
  const { fieldModifications, skipped } = buildLabelModification(
    label,
    {
      amount: "title",
      gone: "title",
      owner: "senderName",
      party: "title",
      signed: "title",
    },
    values,
  );

  assert.deepEqual(fieldModifications, []);
  assert.equal(skipped.length, 5);
  assert.ok(
    skipped.some((reason) => reason.startsWith("gone: no longer on the label")),
  );
  assert.ok(
    skipped.some((reason) =>
      reason.includes('no choice named "Master services agreement"'),
    ),
  );
});

test("a field with no value for this envelope is left alone", () => {
  const { fieldModifications, skipped } = buildLabelModification(
    label,
    { title: "counterparty" },
    { ...values, counterparty: null },
  );

  assert.deepEqual(fieldModifications, []);
  assert.deepEqual(skipped, ["Title: no value for this envelope"]);
});
