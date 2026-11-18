import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversionTargetFor,
  convertToPdf,
  DocumentConversionError,
  exportGoogleFileToPdf,
  pdfFileName,
} from "./convert.ts";
import { DRIVE_API_BASE_URL, DRIVE_UPLOAD_BASE_URL } from "./drive-api.ts";

// Converting to PDF through Drive, against a stand-in for Google's API.

type Call = { body?: unknown; headers: Headers; method: string; url: string };

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 converted");
const SESSION_URL = `${DRIVE_UPLOAD_BASE_URL}/files?upload_id=session-1`;

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function fakeDrive(handle: (call: Call) => Response | undefined): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      body: init?.body,
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url: String(input),
    };

    calls.push(call);

    const response = handle(call);

    if (!response) {
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    }

    return response;
  }) as typeof fetch;

  return { calls, fetchImpl };
}

// The usual answers for an upload, an export and a delete.
function conversionHandler(call: Call): Response | undefined {
  if (
    call.method === "POST" &&
    call.url.startsWith(`${DRIVE_UPLOAD_BASE_URL}/files?`)
  ) {
    return new Response(null, {
      headers: { location: SESSION_URL },
      status: 200,
    });
  }

  if (call.method === "PUT" && call.url === SESSION_URL) {
    return json({ id: "temp-file-1" });
  }

  if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/temp-file-1/export?`)) {
    return new Response(PDF_BYTES, { status: 200 });
  }

  if (
    call.method === "DELETE" &&
    call.url === `${DRIVE_API_BASE_URL}/files/temp-file-1`
  ) {
    return new Response(null, { status: 204 });
  }

  return undefined;
}

test("a PDF passes through without asking Google", async () => {
  const { calls, fetchImpl } = fakeDrive(() => undefined);
  const bytes = new TextEncoder().encode("%PDF-1.4 original");
  const result = await convertToPdf(
    {
      accessToken: "t",
      bytes,
      fileName: "Lease.pdf",
      mimeType: "application/pdf",
    },
    { fetchImpl },
  );

  assert.equal(result.bytes, bytes);
  assert.equal(result.fileName, "Lease.pdf");
  assert.equal(calls.length, 0);
});

test("a Word file is uploaded as a Google Doc, exported and the copy deleted", async () => {
  const { calls, fetchImpl } = fakeDrive(conversionHandler);
  const result = await convertToPdf(
    {
      accessToken: "user-token",
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "Offer letter.docx",
      mimeType: "application/octet-stream",
    },
    { fetchImpl },
  );

  assert.deepEqual(result.bytes, PDF_BYTES);
  assert.equal(result.fileName, "Offer letter.pdf");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "PUT", "GET", "DELETE"],
  );

  const start = calls[0]!;
  const metadata = JSON.parse(String(start.body)) as {
    mimeType: string;
    name: string;
  };

  assert.equal(metadata.mimeType, "application/vnd.google-apps.document");
  assert.equal(metadata.name, "Offer letter");
  assert.equal(
    start.headers.get("x-upload-content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.ok(
    calls.every(
      (call) => call.headers.get("authorization") === "Bearer user-token",
    ),
  );
});

test("the temporary copy is deleted even when the export fails", async () => {
  const { calls, fetchImpl } = fakeDrive((call) =>
    call.url.includes("/export?")
      ? json({ error: { errors: [{ reason: "internalError" }] } }, 500)
      : conversionHandler(call),
  );

  await assert.rejects(
    convertToPdf(
      {
        accessToken: "t",
        bytes: new Uint8Array([1]),
        fileName: "notes.odt",
        mimeType: "application/vnd.oasis.opendocument.text",
      },
      { fetchImpl },
    ),
    (error) =>
      error instanceof DocumentConversionError && error.code === "drive_failed",
  );
  assert.equal(calls.at(-1)?.method, "DELETE");
});

test("a file Drive cannot convert is refused before anything is sent", async () => {
  const { calls, fetchImpl } = fakeDrive(() => undefined);

  await assert.rejects(
    convertToPdf(
      {
        accessToken: "t",
        bytes: new Uint8Array([1]),
        fileName: "photo.png",
        mimeType: "image/png",
      },
      { fetchImpl },
    ),
    (error) =>
      error instanceof DocumentConversionError &&
      error.code === "unsupported_type",
  );
  assert.equal(calls.length, 0);
});

test("conversion targets come from the type, or from the name when the type says nothing", () => {
  assert.equal(
    conversionTargetFor("application/rtf", "x")?.target,
    "application/vnd.google-apps.document",
  );
  assert.equal(
    conversionTargetFor("application/octet-stream", "Budget.XLSX")?.target,
    "application/vnd.google-apps.spreadsheet",
  );
  assert.equal(conversionTargetFor("application/zip", "archive.zip"), null);
  assert.equal(pdfFileName("a/b\\c.docx"), "a b c.pdf");
  assert.equal(pdfFileName("   "), "document.pdf");
});

test("a Google Doc in Drive is exported straight to PDF", async () => {
  const { calls, fetchImpl } = fakeDrive((call) => {
    if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/doc-1?`)) {
      return json({
        id: "doc-1",
        mimeType: "application/vnd.google-apps.document",
        name: "MSA",
      });
    }

    if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/doc-1/export?`)) {
      return new Response(PDF_BYTES);
    }

    return undefined;
  });
  const result = await exportGoogleFileToPdf(
    { accessToken: "t", fileId: "doc-1" },
    { fetchImpl },
  );

  assert.equal(result.fileName, "MSA.pdf");
  assert.deepEqual(result.bytes, PDF_BYTES);
  assert.match(calls[0]!.url, /supportsAllDrives=true/);
});

test("an export over Google's 10 MB limit falls back to the export link", async () => {
  const link =
    "https://docs.google.com/feeds/download/documents/export/Export?id=doc-2&exportFormat=pdf";
  const { fetchImpl } = fakeDrive((call) => {
    if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/doc-2?fields=id`)) {
      return json({
        id: "doc-2",
        mimeType: "application/vnd.google-apps.document",
        name: "Big",
      });
    }

    if (call.url.includes("/files/doc-2/export?")) {
      return json(
        { error: { errors: [{ reason: "exportSizeLimitExceeded" }] } },
        403,
      );
    }

    if (
      call.url.startsWith(
        `${DRIVE_API_BASE_URL}/files/doc-2?fields=exportLinks`,
      )
    ) {
      return json({ exportLinks: { "application/pdf": link } });
    }

    if (call.url === link) {
      return new Response(PDF_BYTES);
    }

    return undefined;
  });
  const result = await exportGoogleFileToPdf(
    { accessToken: "t", fileId: "doc-2" },
    { fetchImpl },
  );

  assert.deepEqual(result.bytes, PDF_BYTES);
});

test("a PDF in Drive is downloaded as it is", async () => {
  const original = new TextEncoder().encode("%PDF-1.5 in drive");
  const { calls, fetchImpl } = fakeDrive((call) => {
    if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/pdf-1?fields`)) {
      return json({
        id: "pdf-1",
        mimeType: "application/pdf",
        name: "Signed NDA.pdf",
        size: "17",
      });
    }

    if (call.url.startsWith(`${DRIVE_API_BASE_URL}/files/pdf-1?alt=media`)) {
      return new Response(original);
    }

    return undefined;
  });
  const result = await exportGoogleFileToPdf(
    { accessToken: "t", fileId: "pdf-1" },
    { fetchImpl },
  );

  assert.deepEqual(result.bytes, original);
  assert.equal(result.fileName, "Signed NDA.pdf");
  assert.equal(calls.length, 2);
});

test("a file in Drive that is too large is refused before it is downloaded", async () => {
  const { calls, fetchImpl } = fakeDrive((call) =>
    call.url.includes("/files/big-1?fields")
      ? json({
          id: "big-1",
          mimeType: "application/pdf",
          name: "Huge.pdf",
          size: String(200 * 1024 * 1024),
        })
      : undefined,
  );

  await assert.rejects(
    exportGoogleFileToPdf({ accessToken: "t", fileId: "big-1" }, { fetchImpl }),
    (error) =>
      error instanceof DocumentConversionError && error.code === "too_large",
  );
  assert.equal(calls.length, 1);
});
