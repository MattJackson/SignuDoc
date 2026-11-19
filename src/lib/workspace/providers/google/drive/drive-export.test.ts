import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { DRIVE_API_BASE_URL, DRIVE_UPLOAD_BASE_URL } from "./drive-api.ts";
import { parseLabelFieldMapping } from "./drive-config.ts";
import {
  ensureFolderPath,
  exportToSharedDrive,
  uploadExecutedCopies,
} from "./drive-export.ts";

// The Shared Drive export's uploads: in all drives, with the envelope's id
// and the file's SHA-256, and a retry finds what an earlier try uploaded
// instead of uploading it again.

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

const copies = [
  {
    bytes: signed,
    fileName: "2026-11-17 — Lease — abcd1234.pdf",
    kind: "signed" as const,
    sha256: sha(signed),
  },
  {
    bytes: certificate,
    fileName: "2026-11-17 — Lease — abcd1234 — certificate.pdf",
    kind: "certificate" as const,
    sha256: sha(certificate),
  },
];

test("the files are uploaded with the envelope id and their SHA-256, in all drives", async () => {
  const drive = fakeSharedDrive({});
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    copies,
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    folders: ["2026"],
  });

  assert.equal(drive.uploads(), 2);
  assert.equal(result.folderId, "folder-2026");
  assert.deepEqual(result.files, [
    { id: "uploaded-1", kind: "signed", reused: false },
    { id: "uploaded-2", kind: "certificate", reused: false },
  ]);

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
    assert.equal(
      new URL(call.url).searchParams.get("supportsAllDrives"),
      "true",
    );
  }
});

test("a retry finds the copies an earlier try made and uploads nothing", async () => {
  const drive = fakeSharedDrive({
    [sha(certificate)]: "earlier-certificate",
    [sha(signed)]: "earlier-signed",
  });
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    copies,
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    folders: ["2026"],
  });

  assert.equal(drive.uploads(), 0);
  assert.deepEqual(
    result.files.map((file) => [file.id, file.reused]),
    [
      ["earlier-signed", true],
      ["earlier-certificate", true],
    ],
  );
  // No folder was made either.
  assert.ok(!drive.calls.some((call) => call.method === "POST"));
});

test("a retry after half an upload sends only the missing file", async () => {
  const drive = fakeSharedDrive({ [sha(signed)]: "earlier-signed" });
  const result = await uploadExecutedCopies({
    accessToken: "sa-token",
    copies,
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    folders: [],
  });

  assert.equal(drive.uploads(), 1);
  assert.deepEqual(
    result.files.map((file) => file.id),
    ["earlier-signed", "uploaded-1"],
  );
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
    copies,
    driveId: "drive-1",
    envelopeId: "env-1",
    fetchImpl: drive.fetchImpl,
    folders: [],
  });

  assert.equal(drive.uploads(), 2);
  assert.equal(result.files[0]?.id, "uploaded-1");
});

test("the whole export returns each file with its address, and no label problem without a label", async () => {
  const drive = fakeSharedDrive({});
  const result = await exportToSharedDrive(
    {
      copies,
      destination: "drive-1",
      envelopeId: "env-1",
      folderPath: ["2026"],
      metadata: {},
    },
    {
      fetchImpl: drive.fetchImpl,
      getAccessToken: async () => "sa-token",
      label: { fields: {}, labelId: null },
    },
  );

  assert.deepEqual(result, {
    files: [
      {
        id: "uploaded-1",
        kind: "signed",
        url: "https://drive.google.com/file/d/uploaded-1/view",
      },
      {
        id: "uploaded-2",
        kind: "certificate",
        url: "https://drive.google.com/file/d/uploaded-2/view",
      },
    ],
    metadataProblem: null,
  });
});

test("a label that cannot be read is a metadata problem, not a failed export", async () => {
  const drive = fakeSharedDrive({});
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("drivelabels")
      ? json({ error: { status: "PERMISSION_DENIED" } }, 403)
      : drive.fetchImpl(input, init)) as typeof fetch;
  const result = await exportToSharedDrive(
    {
      copies,
      destination: "drive-1",
      envelopeId: "env-1",
      folderPath: [],
      metadata: { title: "Lease" },
    },
    {
      fetchImpl,
      getAccessToken: async () => "sa-token",
      label: { fields: { f1: "title" }, labelId: "label-1" },
    },
  );

  assert.equal(result.files.length, 2);
  assert.match(result.metadataProblem ?? "", /403/);
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

test("a folder that exists twice resolves to the oldest one", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));

    return json({ files: [{ id: "oldest" }, { id: "newer" }] });
  }) as typeof fetch;

  assert.equal(
    await ensureFolderPath({
      accessToken: "t",
      driveId: "drive-1",
      fetchImpl,
      folders: ["2026"],
    }),
    "oldest",
  );
  assert.equal(
    new URL(urls[0] ?? "").searchParams.get("orderBy"),
    "createdTime",
  );
});

test("a folder made at the same moment by another export loses to the older one", async () => {
  let lists = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    if (method === "POST") {
      return json({ id: "mine" });
    }

    lists += 1;

    return json({
      files: lists === 1 ? [] : [{ id: "older" }, { id: "mine" }],
    });
  }) as typeof fetch;

  assert.equal(
    await ensureFolderPath({
      accessToken: "t",
      driveId: "drive-1",
      fetchImpl,
      folders: ["2026"],
    }),
    "older",
  );
});
