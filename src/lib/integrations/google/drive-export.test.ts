import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { DRIVE_API_BASE_URL, DRIVE_UPLOAD_BASE_URL } from "./drive-api.ts";
import {
  DEFAULT_DRIVE_FOLDER_PATTERN,
  parseLabelFieldMapping,
  readDriveExportConfig,
  renderDrivePath,
} from "./drive-config.ts";
import {
  afterFailedAttempt,
  MAX_DRIVE_EXPORT_ATTEMPTS,
  nextAttemptDelaySeconds,
  uploadExecutedCopies,
} from "./drive-export.ts";

// The Shared Drive export's retry schedule, its folder layout, and that a
// retry finds what an earlier try uploaded instead of uploading it again.

type Call = { body?: unknown; method: string; url: string };

const signed = new TextEncoder().encode("%PDF signed");
const certificate = new TextEncoder().encode("%PDF certificate");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** A Shared Drive holding `existing` files, found by their appProperties. */
function fakeSharedDrive(
  existing: Record<string, string>,
  trashed: ReadonlySet<string> = new Set(),
) {
  const calls: Call[] = [];
  let uploads = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    calls.push({ body: init?.body, method, url });

    if (method === "GET" && url.startsWith(`${DRIVE_API_BASE_URL}/files?`)) {
      const q = new URL(url).searchParams.get("q") ?? "";

      if (q.includes("signudocSha256")) {
        // A file in the trash is only found by a query that does not ask
        // for "trashed = false", as in Drive.
        const match = Object.entries(existing).find(
          ([digest, id]) =>
            q.includes(digest) &&
            !(q.includes("trashed = false") && trashed.has(id)),
        );

        return json({ files: match ? [{ id: match[1] }] : [] });
      }

      // Folder lookups: none exist yet.
      return json({ files: [] });
    }

    if (method === "POST" && url.startsWith(`${DRIVE_API_BASE_URL}/files?`)) {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name;

      return json({ id: `folder-${name}` });
    }

    if (
      method === "POST" &&
      url.startsWith(`${DRIVE_UPLOAD_BASE_URL}/files?`)
    ) {
      uploads += 1;

      return new Response(null, {
        headers: {
          location: `${DRIVE_UPLOAD_BASE_URL}/files?upload_id=${String(uploads)}`,
        },
      });
    }

    if (method === "PUT") {
      return json({
        id: `uploaded-${new URL(url).searchParams.get("upload_id") ?? ""}`,
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  return { calls, fetchImpl, uploads: () => uploads };
}

const files = [
  {
    bytes: signed,
    kind: "signed" as const,
    name: "2026-11-17 — Lease — abcd1234.pdf",
  },
  {
    bytes: certificate,
    kind: "certificate" as const,
    name: "2026-11-17 — Lease — abcd1234 — certificate.pdf",
  },
];

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
    afterFailedAttempt(MAX_DRIVE_EXPORT_ATTEMPTS - 1, 1000).status,
    "pending",
  );
  assert.equal(
    afterFailedAttempt(MAX_DRIVE_EXPORT_ATTEMPTS, 1000).status,
    "failed",
  );
  assert.equal(afterFailedAttempt(1, 1000, true).status, "failed");
});

test("the files are uploaded with the envelope id and their SHA-256, in all drives", async () => {
  const drive = fakeSharedDrive({});
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    files,
    folders: ["2026"],
  });

  assert.equal(drive.uploads(), 2);
  assert.equal(result.reused, 0);
  assert.equal(result.folderId, "folder-2026");
  assert.equal(result.signedPdfFileId, "uploaded-1");
  assert.equal(result.certificateFileId, "uploaded-2");

  const starts = drive.calls.filter(
    (call) =>
      call.method === "POST" && call.url.startsWith(DRIVE_UPLOAD_BASE_URL),
  );

  for (const start of starts) {
    assert.match(start.url, /supportsAllDrives=true/);
  }

  const metadata = JSON.parse(String(starts[0]?.body)) as {
    appProperties: Record<string, string>;
    parents: string[];
  };

  assert.deepEqual(metadata.parents, ["folder-2026"]);
  assert.equal(metadata.appProperties.signudocEnvelopeId, "env-1");
  assert.equal(metadata.appProperties.signudocSha256, sha(signed));

  for (const call of drive.calls.filter((item) =>
    item.url.startsWith(`${DRIVE_API_BASE_URL}/files?`),
  )) {
    const params = new URL(call.url).searchParams;

    assert.equal(params.get("supportsAllDrives"), "true");
  }
});

test("a retry finds the copies an earlier try made and uploads nothing", async () => {
  const drive = fakeSharedDrive({
    [sha(certificate)]: "earlier-certificate",
    [sha(signed)]: "earlier-signed",
  });
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    files,
    folders: ["2026"],
  });

  assert.equal(drive.uploads(), 0);
  assert.equal(result.reused, 2);
  assert.equal(result.signedPdfFileId, "earlier-signed");
  assert.equal(result.certificateFileId, "earlier-certificate");
  // No folder was made either.
  assert.ok(!drive.calls.some((call) => call.method === "POST"));
});

test("a retry after half an upload sends only the missing file", async () => {
  const drive = fakeSharedDrive({ [sha(signed)]: "earlier-signed" });
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    files,
    folders: [],
  });

  assert.equal(drive.uploads(), 1);
  assert.equal(result.signedPdfFileId, "earlier-signed");
  assert.equal(result.certificateFileId, "uploaded-1");
  // With no folders, the file goes in the Shared Drive's root.
  assert.equal(result.folderId, "drive-1");
});

test("a copy in the trash is not reused", async () => {
  const drive = fakeSharedDrive(
    { [sha(signed)]: "trashed-signed" },
    new Set(["trashed-signed"]),
  );
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    files: [files[0]!],
    folders: [],
  });

  assert.equal(drive.uploads(), 1);
  assert.equal(result.reused, 0);
  assert.equal(result.signedPdfFileId, "uploaded-1");
});

test("the folder layout: folders, then the file name, with the date in UTC", () => {
  const completedAt = Date.UTC(2026, 0, 31, 23, 30) / 1000;

  assert.deepEqual(
    renderDrivePath(DEFAULT_DRIVE_FOLDER_PATTERN, {
      completedAt,
      envelopeId: "3f2a9c1e-1111-4000-8000-000000000000",
      title: "Lease / Unit 4",
    }),
    ["2026", "2026-01-31 — Lease - Unit 4 — 3f2a9c1e"],
  );
  assert.deepEqual(
    renderDrivePath("{yyyy-MM}/{senderEmail}/../{unknown}", {
      completedAt,
      envelopeId: "e",
      senderEmail: "sam@example.com",
      title: "T",
    }),
    ["2026-01", "sam@example.com", "{unknown}"],
  );
  assert.deepEqual(
    renderDrivePath("", { completedAt, envelopeId: "e", title: "T" }).length,
    2,
  );
});

test("the export is on once a Shared Drive is given; the environment wins", () => {
  assert.equal(readDriveExportConfig({}, {}).enabled, false);
  assert.equal(
    readDriveExportConfig({}, { "drive.exportDriveId": "0AAbc" }).driveId,
    "0AAbc",
  );
  assert.deepEqual(
    readDriveExportConfig(
      { GOOGLE_DRIVE_EXPORT_DRIVE_ID: "0AEnv" },
      { "drive.exportDriveId": "0AAbc" },
    ),
    {
      driveId: "0AEnv",
      driveIdSource: "env",
      enabled: true,
      folderPattern: DEFAULT_DRIVE_FOLDER_PATTERN,
      folderPatternSource: "none",
    },
  );
});

test("a label field mapping keeps known values only", () => {
  assert.deepEqual(
    parseLabelFieldMapping(
      JSON.stringify({
        a1: "title",
        b2: "nope",
        "bad id!": "title",
        c3: "counterparty",
      }),
    ),
    { a1: "title", c3: "counterparty" },
  );
  assert.deepEqual(parseLabelFieldMapping("not json"), {});
  assert.deepEqual(parseLabelFieldMapping("[]"), {});
});
