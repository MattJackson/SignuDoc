import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceConfigurationError } from "../service-config.ts";
import { resolveStorageDriver, supportsDirectUploads } from "./driver.ts";
import {
  createGcsClient,
  createGcsStorageService,
  GcsRequestError,
  normalizeGcsPrefix,
} from "./gcs.ts";
import { StorageObjectNotFoundError } from "./types.ts";

type StoredObject = {
  body: Uint8Array;
  contentType: string;
  generation: number;
  updated: Date;
};

type RecordedCall = {
  authorization: string | null;
  method: string;
  url: URL;
};

const API = "https://storage.googleapis.com";
const BUCKET = "docs-bucket";
const KEY = "users/u1/envelopes/e1/original file ü.pdf";

/**
 * An in-memory stand-in for the Cloud Storage JSON API, reached through a
 * fake fetch. It answers the calls the driver makes the way Google does.
 */
function createFakeGcs() {
  const objects = new Map<string, StoredObject>();
  const calls: RecordedCall[] = [];
  const uploads = new Map<
    string,
    { contentType: string; name: string; received: Uint8Array }
  >();
  let generation = 0;
  let failNext: number | null = null;
  // How many bytes of each resumable piece to take; less than all of it
  // makes the client send the rest again.
  let takeFromPiece: ((length: number) => number) | null = null;
  // How many non-final pieces are answered with 308 and no Range, which
  // means nothing was kept.
  let stalledPieces = 0;

  function store(name: string, body: Uint8Array, contentType: string) {
    generation += 1;
    objects.set(name, {
      body,
      contentType,
      generation,
      updated: new Date(Date.UTC(2026, 10, 1, 0, 0, generation)),
    });
  }

  function metadata(name: string, object: StoredObject) {
    return {
      contentType: object.contentType,
      etag: `etag-${String(object.generation)}`,
      generation: String(object.generation),
      name,
      size: String(object.body.byteLength),
      updated: object.updated.toISOString(),
    };
  }

  function describe(name: string) {
    const object = objects.get(name);

    assert.ok(object);

    return metadata(name, object);
  }

  async function readBody(init?: RequestInit): Promise<Uint8Array> {
    if (init?.body === undefined || init.body === null) {
      return new Uint8Array(0);
    }

    return new Uint8Array(await new Response(init.body).arrayBuffer());
  }

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

    calls.push({ authorization: headers.get("authorization"), method, url });

    if (failNext !== null) {
      const status = failNext;

      failNext = null;

      return new Response(`{"error":"secret detail for ${url.href}"}`, {
        status,
      });
    }

    const bucketPrefix = `/storage/v1/b/${BUCKET}/o`;
    const uploadPrefix = `/upload/storage/v1/b/${BUCKET}/o`;

    if (url.pathname === "/resumable") {
      const session = uploads.get(url.searchParams.get("id") ?? "");

      assert.ok(session, "a known upload session");

      const range = headers.get("content-range") ?? "";
      const piece = await readBody(init);
      const match = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(range);
      const empty = /^bytes \*\/(\d+)$/.exec(range);

      if (match) {
        assert.equal(Number(match[1]), session.received.byteLength);
        assert.equal(Number(match[2]) - Number(match[1]) + 1, piece.byteLength);
      } else {
        assert.ok(empty, `a valid Content-Range, not "${range}"`);
      }

      const final = empty ? true : match?.[3] !== "*";

      if (!final && stalledPieces > 0) {
        stalledPieces -= 1;

        return new Response(null, { status: 308 });
      }

      const taken =
        final || !takeFromPiece
          ? piece.byteLength
          : takeFromPiece(piece.byteLength);
      const joined = new Uint8Array(session.received.byteLength + taken);

      joined.set(session.received);
      joined.set(piece.subarray(0, taken), session.received.byteLength);
      session.received = joined;

      if (!final) {
        // With nothing kept yet, Cloud Storage sends no Range header at all.
        return new Response(null, {
          headers:
            joined.byteLength > 0
              ? { range: `bytes=0-${String(joined.byteLength - 1)}` }
              : {},
          status: 308,
        });
      }

      store(session.name, session.received, session.contentType);

      return Response.json({}, { status: 200 });
    }

    if (url.pathname === uploadPrefix && method === "POST") {
      const name = url.searchParams.get("name") ?? "";

      if (url.searchParams.get("uploadType") === "resumable") {
        const id = String(uploads.size + 1);

        uploads.set(id, {
          contentType: headers.get("x-upload-content-type") ?? "",
          name,
          received: new Uint8Array(0),
        });

        return new Response(null, {
          headers: { location: `${API}/resumable?id=${id}` },
          status: 200,
        });
      }

      assert.equal(url.searchParams.get("uploadType"), "media");

      const body = await readBody(init);

      if (
        url.searchParams.get("ifGenerationMatch") === "0" &&
        objects.has(name)
      ) {
        return new Response("precondition failed", { status: 412 });
      }

      store(name, body, headers.get("content-type") ?? "");

      return Response.json(describe(name));
    }

    if (url.pathname === bucketPrefix && method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const pageSize = 2;
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const names = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      const page = names.slice(start, start + pageSize);

      return Response.json({
        items: page.map(describe),
        ...(start + pageSize < names.length
          ? { nextPageToken: String(start + pageSize) }
          : {}),
      });
    }

    if (url.pathname.startsWith(`${bucketPrefix}/`)) {
      // The object's name is one encoded path segment.
      const encoded = url.pathname.slice(bucketPrefix.length + 1);

      assert.ok(!encoded.includes("/"), "slashes in the name are encoded");

      const name = decodeURIComponent(encoded);
      const object = objects.get(name);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      if (method === "DELETE") {
        objects.delete(name);
        return new Response(null, { status: 204 });
      }

      if (url.searchParams.get("alt") === "media") {
        const bytes = object.body;
        // Sent in two pieces, as a real download arrives.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const half = Math.floor(bytes.byteLength / 2);

            controller.enqueue(bytes.slice(0, half));
            controller.enqueue(bytes.slice(half));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": object.contentType,
            etag: `"etag-${String(object.generation)}"`,
          },
        });
      }

      return Response.json(metadata(name, object));
    }

    return new Response("unexpected", { status: 500 });
  };

  return {
    calls,
    failNextWith(status: number) {
      failNext = status;
    },
    fetchImpl: fetchImpl as typeof fetch,
    objects,
    stallNextPieces(count: number) {
      stalledPieces = count;
    },
    setPartialPieces(take: ((length: number) => number) | null) {
      takeFromPiece = take;
    },
  };
}

const credentials = {
  async getAccessToken(request: { scopes: readonly string[] }) {
    assert.deepEqual(request.scopes, [
      "https://www.googleapis.com/auth/devstorage.read_write",
    ]);

    return "token-1";
  },
};

function setUp(env: Record<string, string> = {}) {
  const fake = createFakeGcs();
  const client = createGcsClient({
    bucket: BUCKET,
    credentials,
    fetchImpl: fake.fetchImpl,
  });
  const storage = createGcsStorageService({
    client,
    env: { GCS_BUCKET: BUCKET, ...env },
  });

  return { client, fake, storage };
}

test("an object is written, read whole, streamed and described", async () => {
  const { fake, storage } = setUp();
  // A view into a larger buffer: only the viewed bytes may be stored.
  const body = new Uint8Array([9, 9, 1, 2, 3, 4, 9]).subarray(2, 6);

  const reference = await storage.putObject({
    body,
    contentType: "application/pdf",
    key: `/${KEY}`,
  });

  assert.deepEqual(reference, { bucketName: BUCKET, key: KEY });
  assert.deepEqual([...(fake.objects.get(KEY)?.body ?? [])], [1, 2, 3, 4]);
  assert.equal(fake.objects.get(KEY)?.contentType, "application/pdf");

  const upload = fake.calls[0];

  assert.equal(upload?.method, "POST");
  assert.equal(upload?.url.searchParams.get("name"), KEY);
  assert.equal(upload?.url.searchParams.get("ifGenerationMatch"), null);
  assert.equal(upload?.authorization, "Bearer token-1");

  const object = await storage.getObject(KEY);

  assert.deepEqual([...object.body], [1, 2, 3, 4]);
  assert.equal(object.contentLength, 4);
  assert.equal(object.contentType, "application/pdf");
  assert.equal(object.etag, '"etag-1"');

  const streamed = await storage.getObjectStream(KEY);

  assert.equal(streamed.contentLength, 4);
  assert.equal(streamed.contentType, "application/pdf");

  // The stream is the download itself, read as it arrives.
  const reader = streamed.stream.getReader();
  const first = await reader.read();

  assert.deepEqual([...(first.value ?? [])], [1, 2]);

  const second = await reader.read();

  assert.deepEqual([...(second.value ?? [])], [3, 4]);
  assert.equal((await reader.read()).done, true);

  const head = await storage.headObject(KEY);

  assert.deepEqual(head, {
    bucketName: BUCKET,
    contentLength: 4,
    contentType: "application/pdf",
    etag: "etag-1",
    exists: true,
    key: KEY,
  });

  for (const call of fake.calls) {
    assert.equal(call.authorization, "Bearer token-1");
  }
});

test("a write replaces what is there unless it is to be kept", async () => {
  const { fake, storage } = setUp();

  await storage.putObject({
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    keepExisting: true,
    key: KEY,
  });

  // Even the first write asks Cloud Storage to refuse a replacement, so of
  // two writers at once only one can be kept.
  assert.equal(fake.calls[0]?.url.searchParams.get("ifGenerationMatch"), "0");

  // The second writer loses the race, and that is not an error.
  const reference = await storage.putObject({
    body: new Uint8Array([4, 5, 6]),
    contentType: "image/jpeg",
    keepExisting: true,
    key: KEY,
  });

  assert.equal(reference.key, KEY);
  assert.deepEqual([...(fake.objects.get(KEY)?.body ?? [])], [1, 2, 3]);

  await storage.putObject({
    body: new Uint8Array([7, 8, 9]),
    contentType: "image/jpeg",
    key: KEY,
  });

  assert.deepEqual([...(fake.objects.get(KEY)?.body ?? [])], [7, 8, 9]);
});

test("of writers that arrive together exactly one is kept", async () => {
  const { fake, storage } = setUp();

  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      storage.putObject({
        body: new Uint8Array(16).fill(index + 1),
        contentType: "image/jpeg",
        keepExisting: true,
        key: KEY,
      }),
    ),
  );

  const kept = fake.objects.get(KEY)?.body ?? new Uint8Array(0);

  assert.equal(kept.byteLength, 16);
  assert.ok(kept.every((byte) => byte === kept[0]));
  assert.equal(fake.objects.size, 1);
});

test("a missing object is reported the way the rest of the app expects", async () => {
  const { storage } = setUp();

  await assert.rejects(storage.getObject(KEY), StorageObjectNotFoundError);
  await assert.rejects(
    storage.getObjectStream(KEY),
    StorageObjectNotFoundError,
  );
  assert.deepEqual(await storage.headObject(KEY), {
    bucketName: BUCKET,
    exists: false,
    key: KEY,
  });
  // Deleting what is not there is fine.
  await storage.deleteObject(KEY);
});

test("delete removes the object", async () => {
  const { fake, storage } = setUp();

  await storage.putObject({
    body: new Uint8Array(3),
    contentType: "application/pdf",
    key: KEY,
  });
  await storage.deleteObject(KEY);

  assert.equal(fake.objects.size, 0);
  assert.equal(fake.calls.at(-1)?.method, "DELETE");
});

test("failures are reported by status alone, never with the body", async () => {
  for (const status of [403, 500, 503]) {
    const { fake, storage } = setUp();
    const attempts = [
      () => storage.getObject(KEY),
      () => storage.getObjectStream(KEY),
      () => storage.headObject(KEY),
      () => storage.deleteObject(KEY),
      () =>
        storage.putObject({
          body: new Uint8Array(1),
          contentType: "image/png",
          key: KEY,
        }),
      () =>
        storage.putObject({
          body: new Uint8Array(1),
          contentType: "image/png",
          keepExisting: true,
          key: KEY,
        }),
    ];

    for (const attempt of attempts) {
      fake.failNextWith(status);

      await assert.rejects(attempt(), (error: unknown) => {
        assert.ok(error instanceof GcsRequestError);
        assert.equal(error.status, status);
        assert.match(
          error.message,
          new RegExp(`failed with ${String(status)}`),
        );
        assert.doesNotMatch(error.message, /secret detail/);
        return true;
      });
    }
  }
});

test("a 412 without keepExisting is still a failure", async () => {
  const { fake, storage } = setUp();

  fake.failNextWith(412);

  await assert.rejects(
    storage.putObject({
      body: new Uint8Array(1),
      contentType: "image/png",
      key: KEY,
    }),
    GcsRequestError,
  );
});

test("GCS_PREFIX keeps every object in its folder", async () => {
  const { fake, storage } = setUp({ GCS_PREFIX: "/installs/one/" });

  await storage.putObject({
    body: new Uint8Array([1]),
    contentType: "application/pdf",
    key: KEY,
  });

  assert.ok(fake.objects.has(`installs/one/${KEY}`));

  const object = await storage.getObject(KEY);

  // Callers see the key they gave, without the folder.
  assert.equal(object.key, KEY);

  await storage.deleteObject(KEY);
  assert.equal(fake.objects.size, 0);

  assert.equal(normalizeGcsPrefix(""), "");
  assert.equal(normalizeGcsPrefix(" a/b// "), "a/b/");
  assert.throws(() => normalizeGcsPrefix("a/../b"));
});

test("keys that could escape their folder are refused", async () => {
  const { fake, storage } = setUp();

  await assert.rejects(storage.getObject("users/../secrets.pdf"));
  await assert.rejects(storage.deleteObject(""));
  assert.equal(fake.calls.length, 0);
});

test("listing follows every page", async () => {
  const { client } = setUp();

  for (const name of ["a/1", "a/2", "a/3", "b/1"]) {
    await client.upload(name, "x", { contentType: "text/plain" });
  }

  const names: string[] = [];
  let pageToken: string | undefined;

  do {
    const page = await client.list({ pageToken, prefix: "a/" });

    names.push(...page.items.map((item) => item.name));
    pageToken = page.nextPageToken;
  } while (pageToken);

  assert.deepEqual(names, ["a/1", "a/2", "a/3"]);
});

async function* chunksOf(bytes: Uint8Array, size: number) {
  for (let start = 0; start < bytes.byteLength; start += size) {
    yield bytes.subarray(start, start + size);
  }
}

test("a stream is uploaded in pieces and arrives whole", async () => {
  const { client, fake } = setUp();
  // Over two upload pieces, read in odd-sized chunks.
  const bytes = new Uint8Array(17 * 1024 * 1024 + 123);

  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }

  await client.uploadStream(
    "database/backup.ndjson.gz",
    chunksOf(bytes, 1_000_003),
    {
      contentType: "application/gzip",
    },
  );

  const stored = fake.objects.get("database/backup.ndjson.gz");

  assert.ok(stored);
  assert.equal(stored.contentType, "application/gzip");
  assert.equal(stored.body.byteLength, bytes.byteLength);
  assert.deepEqual(Buffer.from(stored.body), Buffer.from(bytes));

  // Cloud Storage may keep less than a whole piece; the rest is sent again.
  fake.setPartialPieces((length) => length - 256 * 1024);
  await client.uploadStream("partial", chunksOf(bytes, 4 * 1024 * 1024), {
    contentType: "application/octet-stream",
  });
  assert.deepEqual(
    Buffer.from(fake.objects.get("partial")?.body ?? []),
    Buffer.from(bytes),
  );

  // An empty stream makes an empty object.
  fake.setPartialPieces(null);
  await client.uploadStream("empty", chunksOf(new Uint8Array(0), 1), {
    contentType: "application/json",
  });
  assert.equal(fake.objects.get("empty")?.body.byteLength, 0);
});

test("a failed piece fails the upload", async () => {
  const { client, fake } = setUp();
  const bytes = new Uint8Array(9 * 1024 * 1024);

  await assert.rejects(
    client.uploadStream(
      "broken",
      (async function* () {
        for await (const chunk of chunksOf(bytes, 1024 * 1024)) {
          // The first piece goes once this chunk is read.
          if (chunk.byteOffset === 8 * 1024 * 1024) {
            fake.failNextWith(503);
          }

          yield chunk;
        }
      })(),
      { contentType: "application/gzip" },
    ),
    GcsRequestError,
  );
  assert.equal(fake.objects.has("broken"), false);
});

test("an upload Cloud Storage stops taking fails instead of looping", async () => {
  const { client, fake } = setUp();
  const bytes = new Uint8Array(9 * 1024 * 1024);

  // It answers 308 with no Range: nothing of the piece was kept.
  fake.setPartialPieces(() => 0);

  await assert.rejects(
    client.uploadStream("stuck", chunksOf(bytes, 1024 * 1024), {
      contentType: "application/gzip",
    }),
    (error: unknown) =>
      error instanceof GcsRequestError && /upload/.test(error.message),
  );
  // The first try and at most three more (MAX_STALLED_PIECES), then it
  // gives up rather than sending the piece for ever.
  assert.equal(
    fake.calls.filter((call) => call.url.pathname === "/resumable").length,
    4,
  );
  assert.equal(fake.objects.has("stuck"), false);
});

test("the driver says what is missing", () => {
  assert.throws(
    () => createGcsStorageService({ credentials, env: {} }),
    (error: unknown) =>
      error instanceof ServiceConfigurationError &&
      /GCS_BUCKET/.test(error.message),
  );
  // A bucket but no Google credentials (no key, not on Google Cloud).
  assert.throws(
    () =>
      createGcsStorageService({
        credentials: null,
        env: { GCS_BUCKET: BUCKET },
      }),
    (error: unknown) =>
      error instanceof ServiceConfigurationError &&
      /GOOGLE_SERVICE_ACCOUNT_KEY/.test(error.message),
  );
});

test("Cloud Storage is chosen only when STORAGE_DRIVER says so", () => {
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: "gcs" }), "gcs");
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: " GCS " }), "gcs");
  assert.equal(resolveStorageDriver({ GCS_BUCKET: BUCKET }), "local");
  assert.equal(
    resolveStorageDriver({ GCS_BUCKET: BUCKET, K_SERVICE: "signudoc" }),
    "local",
  );
  // Uploads go through the app on Cloud Storage.
  assert.equal(supportsDirectUploads({ STORAGE_DRIVER: "gcs" }), false);
});

test("a piece Cloud Storage kept nothing of is sent again, a few times at most", async () => {
  const { client, fake } = setUp();
  const bytes = new Uint8Array(9 * 1024 * 1024);

  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }

  // A 308 with no Range header says nothing was persisted: send it again.
  fake.stallNextPieces(1);
  await client.uploadStream("stalled-once", chunksOf(bytes, 1024 * 1024), {
    contentType: "application/octet-stream",
  });
  assert.deepEqual(
    Buffer.from(fake.objects.get("stalled-once")?.body ?? []),
    Buffer.from(bytes),
  );

  // Never taking it is still a failure, not a loop that goes round forever.
  fake.stallNextPieces(100);
  await assert.rejects(
    client.uploadStream("never-taken", chunksOf(bytes, 1024 * 1024), {
      contentType: "application/octet-stream",
    }),
    GcsRequestError,
  );
});

test("a request that gets no answer fails by the deadline instead of hanging", async () => {
  // Answers only when the request is given up on; a client that sets no
  // deadline is told so after a second.
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;

      if (!signal) {
        setTimeout(() => reject(new Error("no deadline was set")), 1_000);
        return;
      }

      signal.addEventListener("abort", () => reject(signal.reason));
    })) as typeof fetch;
  const client = createGcsClient({
    bucket: BUCKET,
    credentials,
    fetchImpl,
    requestTimeoutMs: 50,
  });

  await assert.rejects(client.download("a"), GcsRequestError);
  await assert.rejects(
    client.upload("a", new Uint8Array(1), { contentType: "text/plain" }),
    GcsRequestError,
  );
  await assert.rejects(client.getMetadata("a"), GcsRequestError);
});

test("a stream is gathered without copying what is held again for every chunk", async () => {
  const { client, fake } = setUp();
  const bytes = new Uint8Array(24 * 1024 * 1024);

  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }

  // Counts the bytes copied with Uint8Array.set, which is how the pieces
  // are put together.
  const originalSet = Uint8Array.prototype.set;
  let copied = 0;

  Uint8Array.prototype.set = function (
    this: Uint8Array,
    source: ArrayLike<number>,
    offset?: number,
  ) {
    copied += source.length;
    return originalSet.call(this, source, offset);
  };

  try {
    await client.uploadStream("big", chunksOf(bytes, 16 * 1024), {
      contentType: "application/octet-stream",
    });
  } finally {
    Uint8Array.prototype.set = originalSet;
  }

  assert.deepEqual(
    Buffer.from(fake.objects.get("big")?.body ?? []),
    Buffer.from(bytes),
  );
  // Each byte is copied into a piece once (plus the stand-in's own
  // bookkeeping); copying the whole held piece per chunk would be dozens of
  // times the input.
  assert.ok(
    copied < bytes.byteLength * 8,
    `${String(copied)} bytes copied for ${String(bytes.byteLength)}`,
  );
});

test("a body that stops arriving after the headers fails a buffered read by the deadline", async () => {
  // Headers at once, then a body that never ends unless the request is
  // given up on.
  const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason),
          );
        },
      }),
      { headers: { "content-type": "application/pdf" }, status: 200 },
    )) as typeof fetch;
  const client = createGcsClient({
    bucket: BUCKET,
    credentials,
    fetchImpl,
    requestTimeoutMs: 100,
  });
  const storage = createGcsStorageService({
    client,
    env: { GCS_BUCKET: BUCKET },
  });
  const unbounded = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error("the read was never bounded")), 1_500),
  );

  await assert.rejects(
    Promise.race([storage.getObject(KEY), unbounded]),
    GcsRequestError,
  );
});
