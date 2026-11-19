import { randomUUID } from "node:crypto";

import {
  createStorageService,
  resolveStorageDriver,
  type StorageService,
} from "./services/storage.ts";
import { type EnvSource } from "./utils/env.ts";

// For onboarding: which storage holds this install's documents, and a check
// that it can really be written to and read back. Where documents are kept
// is decided when the app is deployed, so it is shown, not changed, here.

export type StorageCheckResult =
  | { driver: string; ok: true }
  | { driver: string | null; message: string; ok: false };

export function describeStorageDriver(env: EnvSource = process.env): {
  driver: string | null;
  problem: string | null;
} {
  try {
    return { driver: resolveStorageDriver(env), problem: null };
  } catch (error) {
    return {
      driver: null,
      problem: error instanceof Error ? error.message : "Unknown storage.",
    };
  }
}

/** Writes a small file, reads it back, and deletes it. */
export async function checkStorage(
  env: EnvSource = process.env,
  storage?: StorageService,
): Promise<StorageCheckResult> {
  const { driver, problem } = describeStorageDriver(env);

  if (!driver) {
    return { driver, message: problem ?? "Unknown storage.", ok: false };
  }

  const key = `onboarding-checks/${randomUUID()}.txt`;
  const body = new TextEncoder().encode(`storage check ${key}`);
  let service: StorageService;

  try {
    service = storage ?? createStorageService({ env });
  } catch (error) {
    return {
      driver,
      message:
        error instanceof Error ? error.message : "Storage is not set up.",
      ok: false,
    };
  }

  try {
    await service.putObject({ body, contentType: "text/plain", key });

    const read = await service.getObject(key);

    if (Buffer.compare(Buffer.from(read.body), Buffer.from(body)) !== 0) {
      return {
        driver,
        message: "A file was written, but a different one was read back.",
        ok: false,
      };
    }

    return { driver, ok: true };
  } catch (error) {
    return {
      driver,
      message:
        error instanceof Error
          ? `Storage did not work: ${error.message}`
          : "Storage did not work.",
      ok: false,
    };
  } finally {
    await service.deleteObject(key).catch(() => undefined);
  }
}
