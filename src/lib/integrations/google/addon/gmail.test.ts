import assert from "node:assert/strict";
import { test } from "node:test";

import { driveFileKind } from "./drive.ts";
import {
  getAttachmentBytes,
  GmailApiError,
  listSignableAttachments,
  parseFromHeader,
  readMessageSummary,
  signableMimeType,
  type GmailMessage,
} from "./gmail.ts";

// The open message, as the Gmail API's messages.get returns it with
// format=full, and the attachment call with both tokens.

const message: GmailMessage = {
  id: "msg-1",
  payload: {
    headers: [
      { name: "From", value: '"Pat Client" <Pat@Client.Example>' },
      { name: "Subject", value: "  Contract for review " },
    ],
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        partId: "0",
        parts: [
          { body: { size: 10 }, mimeType: "text/plain", partId: "0.0" },
          { body: { size: 20 }, mimeType: "text/html", partId: "0.1" },
        ],
      },
      {
        body: { attachmentId: "a-pdf", size: 1200 },
        filename: "Contract.pdf",
        mimeType: "application/pdf",
        partId: "1",
      },
      {
        body: { attachmentId: "a-img", size: 500 },
        filename: "logo.png",
        mimeType: "image/png",
        partId: "2",
      },
      {
        body: { attachmentId: "a-doc", size: 25 * 1024 * 1024 },
        filename: "Terms.DOCX",
        mimeType: "application/octet-stream",
        partId: "3",
      },
    ],
  },
};

test("PDF and Word attachments are listed, in order, and nothing else", () => {
  assert.deepEqual(listSignableAttachments(message), [
    {
      attachmentId: "a-pdf",
      fileName: "Contract.pdf",
      mimeType: "application/pdf",
      partId: "1",
      sizeBytes: 1200,
      tooLarge: false,
    },
    {
      attachmentId: "a-doc",
      fileName: "Terms.DOCX",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partId: "3",
      sizeBytes: 25 * 1024 * 1024,
      tooLarge: true,
    },
  ]);
  assert.deepEqual(listSignableAttachments({}), []);
});

test("an attachment inside a forwarded message is found", () => {
  const forwarded: GmailMessage = {
    id: "msg-2",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          body: { attachmentId: "a-first", size: 100 },
          filename: "First.pdf",
          mimeType: "application/pdf",
          partId: "1",
        },
        {
          mimeType: "multipart/mixed",
          partId: "2",
          parts: [
            {
              mimeType: "multipart/related",
              partId: "2.1",
              parts: [
                {
                  body: { attachmentId: "a-deep", size: 300 },
                  filename: "Deep.pdf",
                  mimeType: "application/pdf",
                  partId: "2.1.1",
                },
              ],
            },
            {
              body: { attachmentId: "a-nested", size: 200 },
              filename: "Nested.pdf",
              mimeType: "application/pdf",
              partId: "2.2",
            },
          ],
        },
        {
          body: { attachmentId: "a-last", size: 400 },
          filename: "Last.pdf",
          mimeType: "application/pdf",
          partId: "3",
        },
      ],
    },
  };

  assert.deepEqual(
    listSignableAttachments(forwarded).map((attachment) => attachment.partId),
    ["1", "2.1.1", "2.2", "3"],
  );
});

test("a file's type is read from its MIME type, or else its name", () => {
  assert.equal(signableMimeType("APPLICATION/PDF", "x"), "application/pdf");
  assert.equal(
    signableMimeType("application/octet-stream", "a.doc"),
    "application/msword",
  );
  assert.equal(signableMimeType("application/octet-stream", "a.zip"), null);
  assert.equal(
    driveFileKind("application/vnd.google-apps.document"),
    "google-doc",
  );
  assert.equal(driveFileKind("application/vnd.google-apps.spreadsheet"), null);
});

test("the sender and subject come from the headers", () => {
  assert.deepEqual(readMessageSummary(message), {
    sender: { email: "pat@client.example", name: "Pat Client" },
    subject: "Contract for review",
  });
  assert.deepEqual(parseFromHeader("<kim@example.com>"), {
    email: "kim@example.com",
    name: null,
  });
  assert.deepEqual(parseFromHeader("kim@example.com"), {
    email: "kim@example.com",
    name: null,
  });
  assert.equal(parseFromHeader("Undisclosed recipients"), null);
  assert.equal(readMessageSummary({}).subject, "(no subject)");
});

test("an attachment is fetched with the user's token and the message's token", async () => {
  const seen: { headers: Headers; url: string }[] = [];
  const bytes = await getAttachmentBytes(
    "msg-1",
    "a-pdf",
    { messageAccessToken: "message-token", userOAuthToken: "user-token" },
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), url: String(url) });

      return new Response(
        JSON.stringify({ data: Buffer.from("%PDF-1.7").toString("base64url") }),
      );
    }) as typeof fetch,
  );

  assert.equal(Buffer.from(bytes).toString("utf8"), "%PDF-1.7");

  const request = seen[0]!;

  assert.equal(
    request.url,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1/attachments/a-pdf",
  );
  assert.equal(request.headers.get("authorization"), "Bearer user-token");
  assert.equal(
    request.headers.get("x-goog-gmail-access-token"),
    "message-token",
  );

  await assert.rejects(
    getAttachmentBytes(
      "msg-1",
      "a-pdf",
      { messageAccessToken: "m", userOAuthToken: "u" },
      (async () => new Response("{}", { status: 403 })) as typeof fetch,
    ),
    (error) => error instanceof GmailApiError && error.status === 403,
  );
});
