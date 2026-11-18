import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  type BackupBlob,
  type BackupStore,
  type BackupTarget,
  createVercelBlobStore,
} from "./backup.ts";
import {
  getGoogleCredentials,
  type GoogleCredentials,
} from "./integrations/google/credentials.ts";
import { ServiceConfigurationError } from "./services/service-config.ts";
import { resolveStorageDriver } from "./services/storage/driver.ts";
import {
  createGcsClient,
  type GcsClient,
  type GcsTokenSource,
  readGcsLocation,
} from "./services/storage/gcs.ts";
import { createLocalStorageService } from "./services/storage/local.ts";
import { type EnvSource, readEnv } from "./utils/env.ts";

// The places a backup reads from and writes to, as BackupStores
// (backup.ts): Vercel Blob, a Google Cloud Storage bucket, or the local
// disk. The install's own files are read from whichever of these it keeps
// them in, so a backup works whatever the storage driver.

type BackupBody = Parameters<BackupStore["put"]>[1];

function toAsyncIterable(
  body: ReadableStream<Uint8Array> | Readable,
): AsyncIterable<Uint8Array> {
  return body instanceof Readable
    ? (body as AsyncIterable<Uint8Array>)
    : (Readable.fromWeb(
        body as import("node:stream/web").ReadableStream,
      ) as AsyncIterable<Uint8Array>);
}

/** A Cloud Storage bucket, or the folder `prefix` inside it. */
export function createGcsBackupStore({
  client,
  prefix = "",
}: {
  client: GcsClient;
  prefix?: string;
}): BackupStore {
  return {
    async delete(pathnames) {
      for (const pathname of pathnames) {
        await client.deleteObject(`${prefix}${pathname}`);
      }
    },
    async get(pathname) {
      const response = await client.download(`${prefix}${pathname}`);

      if (!response?.body) {
        return null;
      }

      return {
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
        stream: response.body,
      };
    },
    async list({ cursor, prefix: listPrefix = "" }) {
      const page = await client.list({
        pageToken: cursor,
        prefix: `${prefix}${listPrefix}`,
      });

      return {
        blobs: page.items.map((item) => ({
          pathname: item.name.slice(prefix.length),
          size: item.size,
          uploadedAt: item.updated,
        })),
        cursor: page.nextPageToken,
        hasMore: Boolean(page.nextPageToken),
      };
    },
    async put(pathname, body: BackupBody, { contentType }) {
      const name = `${prefix}${pathname}`;

      if (typeof body === "string" || Buffer.isBuffer(body)) {
        await client.upload(name, body, { contentType });
        return;
      }

      await client.uploadStream(name, toAsyncIterable(body), { contentType });
    },
  };
}

const LOCAL_METADATA_SUFFIX = ".meta.json";

/**
 * The local storage driver's folder. Only the install's own files are
 * read from here, and a restore writes them back; it is never a backup
 * target, since a copy on the same disk is no backup.
 */
export function createLocalBackupStore(
  env: EnvSource = process.env,
): BackupStore {
  const storage = createLocalStorageService({ env });
  const rootDir = path.resolve(
    /*turbopackIgnore: true*/ readEnv(env, "STORAGE_LOCAL_DIR") ??
      ".data/storage",
  );

  async function walk(dir: string, into: BackupBlob[]) {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(/*turbopackIgnore: true*/ dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, into);
        continue;
      }

      if (
        !entry.isFile() ||
        entry.name.endsWith(LOCAL_METADATA_SUFFIX) ||
        entry.name.endsWith(".tmp")
      ) {
        continue;
      }

      const stats = await stat(fullPath);

      into.push({
        pathname: path.relative(rootDir, fullPath).split(path.sep).join("/"),
        size: stats.size,
        uploadedAt: stats.mtime,
      });
    }
  }

  return {
    async delete(pathnames) {
      for (const pathname of pathnames) {
        await storage.deleteObject(pathname);
      }
    },
    async get(pathname) {
      try {
        const object = await storage.getObjectStream(pathname);

        return {
          contentType: object.contentType ?? "application/octet-stream",
          stream: object.stream,
        };
      } catch (error) {
        if ((error as Error).name === "StorageObjectNotFoundError") {
          return null;
        }

        throw error;
      }
    },
    async list({ prefix = "" }) {
      const blobs: BackupBlob[] = [];

      await walk(rootDir, blobs);

      return {
        blobs: blobs
          .filter((blob) => blob.pathname.startsWith(prefix))
          .sort((a, b) => a.pathname.localeCompare(b.pathname)),
        hasMore: false,
      };
    },
    async put(pathname, body: BackupBody, { contentType }) {
      // Files here are uploads, at most the upload limit, so reading one
      // into memory is fine.
      let bytes: Buffer;

      if (typeof body === "string") {
        bytes = Buffer.from(body);
      } else if (Buffer.isBuffer(body)) {
        bytes = body;
      } else {
        const chunks: Buffer[] = [];

        for await (const chunk of toAsyncIterable(body)) {
          chunks.push(Buffer.from(chunk));
        }

        bytes = Buffer.concat(chunks);
      }

      await storage.putObject({ body: bytes, contentType, key: pathname });
    },
  };
}

function requireCredentials(
  credentials: GcsTokenSource | null,
): GcsTokenSource {
  if (!credentials) {
    throw new ServiceConfigurationError("backup", [
      "GOOGLE_SERVICE_ACCOUNT_KEY",
    ]);
  }

  return credentials;
}

/** The install's own files, wherever the storage driver keeps them. */
export function createAppFilesStore({
  credentials = getGoogleCredentials(),
  env = process.env,
}: {
  credentials?: GcsTokenSource | null;
  env?: EnvSource;
} = {}): BackupStore {
  switch (resolveStorageDriver(env)) {
    case "blob":
      return createVercelBlobStore();
    case "gcs": {
      const location = readGcsLocation(env);

      if (!location) {
        throw new ServiceConfigurationError("storage", ["GCS_BUCKET"]);
      }

      return createGcsBackupStore({
        client: createGcsClient({
          bucket: location.bucket,
          credentials: requireCredentials(credentials),
        }),
        prefix: location.prefix,
      });
    }
    case "local":
      return createLocalBackupStore(env);
  }
}

/** The store a backup target names. */
export function createBackupTargetStore(
  target: BackupTarget,
  credentials: GcsTokenSource | null = getGoogleCredentials(),
): BackupStore {
  if (target.kind === "blob") {
    return createVercelBlobStore(target.token);
  }

  return createGcsBackupStore({
    client: createGcsClient({
      bucket: target.bucket,
      credentials: requireCredentials(credentials),
    }),
    prefix: target.prefix,
  });
}

/** The service account the app acts as on Google Cloud, when it has one. */
export async function findServiceAccountEmail(
  getCredentials: () => Pick<
    GoogleCredentials,
    "getServiceAccountEmail"
  > | null = getGoogleCredentials,
): Promise<string | null> {
  try {
    const credentials = getCredentials();

    return credentials ? await credentials.getServiceAccountEmail() : null;
  } catch {
    return null;
  }
}
