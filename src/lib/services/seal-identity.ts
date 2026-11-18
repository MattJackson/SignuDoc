import { X509Certificate, generateKeyPairSync, randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { getDb, withTransaction, type DbPool } from "../db/connection.ts";
import type { Branding } from "../branding.ts";
import {
  getSealTimestampUrl,
  readSealSettings,
  resolveSealCertificate,
  type ResolvedSealCertificate,
} from "../seal-settings.ts";
import { getBranding } from "../settings.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import {
  addLongTermValidation,
  isSelfSigned,
  parseCertificate,
  type ValidationFetch,
} from "./pdf-ltv.ts";
import {
  createSelfSignedSealIdentity,
  requestDocumentTimestamp,
  saveSealedPdf,
  sealIdentityFromPkcs12,
  type SealIdentity,
  type SealOptions,
} from "./pdf-seal.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "./secret-box.ts";

// Kept here too, where they started, for the modules that import them.
export { decryptPrivateKey, encryptPrivateKey, secretKeyFor };

// Where the install's seal key comes from (seal-settings.ts decides):
//
// 1. SEAL_P12_BASE64 (+ SEAL_P12_PASSWORD): a certificate the organization
//    bought from a certificate authority, so readers show its name as
//    verified. Used as given, never stored.
// 2. A PKCS#12 file an administrator uploaded in Settings, kept encrypted
//    with the other integration settings.
// 3. Otherwise a key the install makes for itself the first time it seals a
//    document. The private key is kept in the seal_keys table, encrypted with
//    a key derived from the auth secret. If that secret changes and the old
//    key can no longer be read, a new one is made; documents sealed before
//    still verify, because each carries its own certificate.
//
// Switching between them leaves the install's own key in seal_keys, so
// switching back seals with the same certificate as before.

const KEY_CONTEXT = "signudoc/seal-key/v1";
const SEAL_KEY_LOCK_ID = 746108325;

type CachedIdentity = {
  identity: SealIdentity;
  /** Which choice it was loaded for; another choice loads again. */
  key: string;
  source: string;
};

declare global {
  var __signudocSealIdentity: CachedIdentity | undefined;
}

function encryptionKey(env: EnvSource): Buffer {
  return secretKeyFor(KEY_CONTEXT, env);
}

type SealKeyRow = {
  certificatePem: string;
  encryptedPrivateKey: string;
  id: string;
};

async function identityFromDatabase(
  env: EnvSource,
  database: DbPool,
): Promise<{ identity: SealIdentity; source: string }> {
  const key = encryptionKey(env);
  // Read before the transaction: settings come through another connection,
  // which a full pool could not give while this one waits on the lock.
  const branding = await getBranding(env);

  return withTransaction(async (tx) => {
    // One instance makes the key; any other waits here and then reads it.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SEAL_KEY_LOCK_ID]);

    const existing = await tx.query<SealKeyRow>(
      `
        SELECT
          id,
          certificate_pem AS "certificatePem",
          encrypted_private_key AS "encryptedPrivateKey"
        FROM seal_keys
        WHERE retired_at IS NULL
        LIMIT 1
      `,
    );
    const row = existing.rows[0];

    if (row) {
      const privateKeyPem = decryptPrivateKey(row.encryptedPrivateKey, key);

      if (privateKeyPem) {
        return {
          identity: {
            certificateChainPem: [row.certificatePem],
            privateKeyPem,
          },
          source: `database:${row.id}`,
        };
      }

      console.warn(
        "[seal] The stored seal key cannot be read with the current auth secret; making a new one.",
      );
    }

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const generated = createSelfSignedSealIdentity({
      commonName: `${branding.organizationName ?? branding.productName} document seal`,
      organization: branding.organizationName,
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
    });
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();

    await tx.query(
      `UPDATE seal_keys SET retired_at = $1 WHERE retired_at IS NULL`,
      [now],
    );
    await tx.query(
      `
        INSERT INTO seal_keys (id, certificate_pem, encrypted_private_key, created_at)
        VALUES ($1, $2, $3, $4)
      `,
      [id, generated.certificatePem, encryptPrivateKey(privateKey, key), now],
    );

    return { identity: generated, source: `database:${id}` };
  }, database);
}

function cacheKeyFor(choice: ResolvedSealCertificate): string {
  switch (choice.kind) {
    case "environment":
      return "environment";
    case "pkcs12":
      return `pkcs12:${choice.summary.fingerprint}`;
    case "install":
      return "install";
  }
}

async function loadIdentity(
  choice: ResolvedSealCertificate,
  env: EnvSource,
  database: DbPool,
): Promise<{ identity: SealIdentity; source: string }> {
  if (choice.kind === "environment") {
    return {
      identity: sealIdentityFromPkcs12(
        new Uint8Array(Buffer.from(choice.bundleBase64, "base64")),
        choice.password,
      ),
      source: "environment",
    };
  }

  if (choice.kind === "pkcs12") {
    try {
      return {
        identity: sealIdentityFromPkcs12(
          new Uint8Array(Buffer.from(choice.bundleBase64, "base64")),
          choice.password,
          "The uploaded certificate file",
        ),
        source: "settings",
      };
    } catch (error) {
      // It was checked when it was uploaded, so this is unexpected. A
      // document must still be sealed: the install's own key does it.
      console.error(
        "[seal] The uploaded seal certificate could not be read; sealing with the install's own certificate.",
        error,
      );
    }
  } else if (choice.problem) {
    console.warn(`[seal] ${choice.problem}`);
  }

  return identityFromDatabase(env, database);
}

/**
 * The key and certificate that seal now. The choice is read from the
 * settings (cached briefly) each time, so a change made on one instance
 * reaches the others within the settings cache's time; the key itself is
 * only loaded again when the choice changed.
 */
export async function getSealIdentity({
  database,
  env = process.env,
}: { database?: DbPool; env?: EnvSource } = {}): Promise<SealIdentity> {
  // With the certificate in the environment, the database is not asked.
  const stored = readEnv(env, "SEAL_P12_BASE64")
    ? {}
    : await readSealSettings(env, database);
  const choice = resolveSealCertificate(env, stored);
  const key = cacheKeyFor(choice);
  const cached = globalThis.__signudocSealIdentity;

  if (cached && cached.key === key) {
    return cached.identity;
  }

  const loaded = await loadIdentity(choice, env, database ?? getDb());

  globalThis.__signudocSealIdentity = { ...loaded, key };

  return loaded.identity;
}

/** Forgets the loaded key, for tests. */
export function resetSealIdentityCache() {
  globalThis.__signudocSealIdentity = undefined;
}

export type SealPurpose = "signed-document" | "certificate";

/**
 * Saves a finished PDF sealed with the install's key, so any later change to
 * it shows in a PDF reader.
 */
export async function saveInstallSealedPdf(
  pdfDocument: PDFDocument,
  purpose: SealPurpose,
  {
    branding: givenBranding,
    database,
    env = process.env,
    identity,
    timestampUrl: givenTimestampUrl,
  }: {
    branding?: Branding;
    database?: DbPool;
    env?: EnvSource;
    identity?: SealIdentity;
    /** The timestamp server, read already; null for none. */
    timestampUrl?: string | null;
  } = {},
): Promise<Uint8Array> {
  const sealIdentity = identity ?? (await getSealIdentity({ database, env }));
  const branding = givenBranding ?? (await getBranding(env));
  const timestampUrl =
    givenTimestampUrl !== undefined
      ? givenTimestampUrl
      : await getSealTimestampUrl(env, { database });
  const options: SealOptions = {
    contactInfo: branding.supportAddress ?? "",
    name: branding.organizationName ?? branding.productName,
    reason:
      purpose === "signed-document"
        ? `Signed with ${branding.productName}; sealed so that later changes are detectable`
        : `${branding.productName} audit certificate`,
    timestampUrl,
  };

  return sealForTheLongTerm(pdfDocument, sealIdentity, options);
}

/**
 * Seals the document (PAdES B-B, or B-T with a time-stamping service), then
 * adds what keeps the seal checkable for years: the certificates and
 * revocation answers (B-LT) and an archive timestamp over them (B-LTA).
 * Each step after the first only adds to the file, and is skipped with a
 * logged reason when a service it needs cannot be reached.
 */
export async function sealForTheLongTerm(
  pdfDocument: PDFDocument,
  identity: SealIdentity,
  options: SealOptions,
  { fetch }: { fetch?: ValidationFetch } = {},
): Promise<Uint8Array> {
  const timestampUrl = options.timestampUrl ?? null;
  // A self-made certificate has no issuer to ask about, so without a
  // timestamp there is nothing to add for it.
  const fromAuthority = isCertificateAuthoritySeal(identity);

  if (!timestampUrl) {
    const sealed = await saveSealedPdf(pdfDocument, identity, options);

    return fromAuthority ? withLongTermValidation(sealed, null, fetch) : sealed;
  }

  let sealed: Uint8Array;

  try {
    sealed = await saveSealedPdf(
      await clonePdf(pdfDocument),
      identity,
      options,
    );
  } catch (error) {
    // A time-stamping service that is down must not stop a signing. The
    // document is still sealed, only without the independent time.
    console.error("[seal] Timestamping failed; sealing without it.", error);
    sealed = await saveSealedPdf(pdfDocument, identity, {
      ...options,
      timestampUrl: null,
    });

    return fromAuthority ? withLongTermValidation(sealed, null, fetch) : sealed;
  }

  return withLongTermValidation(sealed, timestampUrl, fetch);
}

/** Whether the seal certificate was issued by someone else. */
function isCertificateAuthoritySeal(identity: SealIdentity): boolean {
  try {
    return !isSelfSigned(
      parseCertificate(
        new X509Certificate(identity.certificateChainPem[0]!).raw,
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Adds long-term validation (PAdES B-LT) and, with a time-stamping service,
 * an archive timestamp (B-LTA). It only adds to a seal already made, so
 * when a certificate authority or the time-stamping service cannot be
 * reached the document keeps the seal it has, and the reason is logged.
 */
async function withLongTermValidation(
  sealed: Uint8Array,
  timestampUrl: string | null,
  fetch: ValidationFetch | undefined,
  whose: "seal" | "signers" = "seal",
): Promise<Uint8Array> {
  try {
    const result = await addLongTermValidation(sealed, {
      fetch,
      timestamp: timestampUrl
        ? (digest) => requestDocumentTimestamp(digest, timestampUrl)
        : null,
    });

    if (result.revoked.length > 0) {
      console.error(
        whose === "seal"
          ? `[seal] A certificate authority says these certificates are revoked: ${result.revoked.join("; ")}. Readers will not accept the seal. Replace the seal certificate (Settings, Seal & timestamp, or SEAL_P12_BASE64).`
          : `[seal] A certificate authority says these signers' certificates are revoked: ${result.revoked.join("; ")}. Readers will not accept those signatures.`,
      );
    }

    if (result.problems.length > 0) {
      console.warn(
        `[seal] Long-term validation is incomplete: ${result.problems.join(" ")}`,
      );
    }

    return result.bytes;
  } catch (error) {
    console.error(
      "[seal] Adding long-term validation failed; keeping the seal without it.",
      error,
    );
    return sealed;
  }
}

/**
 * The finished PDF of an envelope whose signers signed with certificates in
 * their own names: the last signer's revision, with the validation data of
 * every signature in it (PAdES B-LT), and with a timestamp server (the seal
 * settings) an archive timestamp over all of it (B-LTA). The signers'
 * signatures already protect the document, so the install adds no seal of
 * its own here.
 */
export async function finishSignerSignedPdf(
  revision: Uint8Array,
  {
    env = process.env,
    fetch,
    timestampUrl,
  }: {
    env?: EnvSource;
    fetch?: ValidationFetch;
    /** The timestamp server, read already; null for none. */
    timestampUrl?: string | null;
  } = {},
): Promise<Uint8Array> {
  return withLongTermValidation(
    revision,
    timestampUrl !== undefined ? timestampUrl : await getSealTimestampUrl(env),
    fetch,
    "signers",
  );
}

async function clonePdf(pdfDocument: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await pdfDocument.save({ useObjectStreams: false }));
}
