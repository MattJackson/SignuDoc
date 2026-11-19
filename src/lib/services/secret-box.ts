import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import {
  isProduction,
  resolveAuthSecret,
  type EnvSource,
} from "../utils/env.ts";

// Keeping a secret in the database: AES-256-GCM with a key derived from the
// auth secret, one key per purpose. The seal key (seal-identity.ts), the
// settings an administrator enters in the app (integration-settings.ts) and
// the backup token all use the same box.
// It lives on its own so that those modules can use it without importing
// each other.

/**
 * A key for keeping something secret in the database, derived from the
 * auth secret for one purpose (the context).
 */
export function secretKeyFor(
  context: string,
  env: EnvSource = process.env,
): Buffer {
  const secret = resolveAuthSecret(env);

  if (!secret) {
    if (isProduction(env)) {
      throw new Error(
        "Sealing documents needs BETTER_AUTH_SECRET, or a database password of at least 12 characters.",
      );
    }

    // Local development without a password: nothing worth protecting.
    return Buffer.from(
      hkdfSync("sha256", "signudoc-development", "", context, 32),
    );
  }

  return Buffer.from(hkdfSync("sha256", secret, "", context, 32));
}

export function encryptPrivateKey(pem: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);

  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

export function decryptPrivateKey(value: string, key: Buffer): string | null {
  const [version, iv, tag, body] = value.split(".");

  if (version !== "v1" || !iv || !tag || !body) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );

    decipher.setAuthTag(Buffer.from(tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
