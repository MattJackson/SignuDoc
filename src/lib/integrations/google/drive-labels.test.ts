import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLabelModification,
  buildLabelValues,
  findCounterparty,
  type DriveLabel,
} from "./drive-labels.ts";

// Filling a Drive label's fields from an envelope.

const label: DriveLabel = {
  fields: [
    { id: "title", properties: { displayName: "Title" }, textOptions: {} },
    { id: "signed", dateOptions: {}, properties: { displayName: "Signed on" } },
    { id: "owner", properties: { displayName: "Owner" }, userOptions: {} },
    {
      id: "team",
      properties: { displayName: "Team" },
      selectionOptions: {
        choices: [
          { id: "c-sales", properties: { displayName: "Sales" } },
          { id: "c-legal", properties: { displayName: "Legal" } },
        ],
      },
    },
    { id: "amount", integerOptions: {}, properties: { displayName: "Amount" } },
  ],
  id: "label-1",
};

const values = buildLabelValues({
  completedAt: Date.UTC(2026, 10, 17, 12) / 1000,
  counterparty: { email: "pat@customer.example", name: "Pat Customer" },
  envelopeId: "env-1",
  senderEmail: "sam@example.com",
  senderName: "Sam Sender",
  senderTeams: ["Sales"],
  title: "Master services agreement",
});

test("each field gets the value of its kind", () => {
  const { fieldModifications, skipped } = buildLabelModification(
    label,
    {
      owner: "senderEmail",
      signed: "completedDate",
      team: "senderTeam",
      title: "title",
    },
    values,
  );

  assert.deepEqual(fieldModifications, [
    { fieldId: "owner", setUserValues: ["sam@example.com"] },
    { fieldId: "signed", setDateValues: ["2026-11-17"] },
    { fieldId: "team", setSelectionValues: ["c-sales"] },
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
      signed: "title",
      team: "counterparty",
    },
    values,
  );

  assert.deepEqual(fieldModifications, []);
  assert.equal(skipped.length, 5);
  assert.ok(
    skipped.some((reason) => reason.startsWith("gone: no longer on the label")),
  );
  assert.ok(
    skipped.some((reason) => reason.includes('no choice named "Pat Customer"')),
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

test("the counterparty is the first signer outside the Workspace domains", () => {
  const signers = [
    { email: "manager@example.com", name: "Manager", role: "signer" },
    { email: "cc@outside.example", name: "Copy", role: "cc" },
    { email: "pat@customer.example", name: "Pat", role: "signer" },
    { email: "lee@other.example", name: "Lee", role: "signer" },
  ];

  assert.deepEqual(
    findCounterparty(signers, ["example.com"], "sam@example.com"),
    {
      email: "pat@customer.example",
      name: "Pat",
    },
  );
  // With no domains known, the sender's own domain is inside.
  assert.equal(
    findCounterparty(signers, [], "sam@example.com")?.email,
    "pat@customer.example",
  );
  assert.equal(
    findCounterparty(signers.slice(0, 1), ["example.com"], "sam@example.com"),
    null,
  );
});
