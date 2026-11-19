import assert from "node:assert/strict";
import { test } from "node:test";

import { DocumentConversionError } from "../drive/convert.ts";
import { DriveApiError } from "../drive/drive-api.ts";
import {
  isSendableDriveFile,
  needsFileAccess,
  readDriveFileAsPdf,
} from "./drive.ts";

// The selected Drive file, read as the person with the add-on's token for
// them: what can be sent, the PDF itself, and telling "not given to the
// add-on yet" from other failures.

test("PDFs, documents and Google files can be sent; others cannot", () => {
  assert.equal(isSendableDriveFile("application/pdf"), true);
  assert.equal(
    isSendableDriveFile("application/vnd.google-apps.document"),
    true,
  );
  assert.equal(
    isSendableDriveFile(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    true,
  );
  assert.equal(isSendableDriveFile("application/zip"), false);
  assert.equal(
    isSendableDriveFile("application/vnd.google-apps.folder"),
    false,
  );
});

test("a selected PDF is read with the person's token", async () => {
  const seen: { authorization: string | null; url: string }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const address = String(url);

    seen.push({
      authorization: new Headers(init?.headers).get("authorization"),
      url: address,
    });

    return address.includes("alt=media")
      ? new Response(new TextEncoder().encode("%PDF-1.7 test"))
      : Response.json({
          id: "file-1",
          mimeType: "application/pdf",
          name: "Offer.pdf",
          size: "13",
        });
  }) as typeof fetch;

  const pdf = await readDriveFileAsPdf("file-1", "ya29.user", fetchImpl);

  assert.equal(pdf.fileName, "Offer.pdf");
  assert.equal(new TextDecoder().decode(pdf.bytes), "%PDF-1.7 test");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((call) => call.authorization === "Bearer ya29.user"));
  assert.ok(seen.every((call) => call.url.includes("/files/file-1")));
});

test("a file the add-on was not given asks for it; other failures do not", async () => {
  for (const status of [403, 404]) {
    const fetchImpl = (async () =>
      Response.json({}, { status })) as typeof fetch;

    await assert.rejects(
      readDriveFileAsPdf("file-1", "ya29.user", fetchImpl),
      (error) => needsFileAccess(error),
    );
  }

  assert.equal(needsFileAccess(new DriveApiError("Reading", 500, null)), false);
  assert.equal(
    needsFileAccess(new DriveApiError("Reading", null, null)),
    false,
  );
  assert.equal(
    needsFileAccess(new DocumentConversionError("unsupported_type")),
    false,
  );
  assert.equal(needsFileAccess(new Error("other")), false);
});
