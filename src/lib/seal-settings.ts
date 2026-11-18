import { X509Certificate } from "node:crypto";

import { type DbExecutor } from "./db/connection.ts";
import {
  getIntegrationSettings,
  readIntegrationSettings,
  type IntegrationSettings,
} from "./integration-settings.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { readEnv, resolveDatabaseUrl, type EnvSource } from "./utils/env.ts";

// What the seal on finished PDFs is made with, as an administrator chose it
// in Settings (or in the "Seal & timestamp" onboarding step), with the
// environment always winning:
//
// - The timestamp server. SEAL_TIMESTAMP_URL fixes it ("off" turns it off).
//   Otherwise the stored seal.timestampUrl: a URL, or "off". First-run setup
//   stores DigiCert's free server for a new install, so new installs get
//   trusted times from the start; an install set up before this setting
//   existed has nothing stored and keeps sealing without a timestamp until
//   an administrator chooses.
// - The seal certificate. SEAL_P12_BASE64 (+ SEAL_P12_PASSWORD) fixes it.
//   Otherwise seal.certificate says which one: the install's own
//   self-signed certificate (the default), or a PKCS#12 file the
//   administrator uploaded, kept encrypted in seal.p12 and
//   seal.p12Password. A Cloud KMS key is planned; its setting has a place in
//   the type already, so adding it needs no change to what is stored.
//
// Switching certificates never touches documents already sealed: each PDF
// carries the certificate it was sealed with, and the install's own key
// stays in seal_keys, ready if the administrator switches back.

export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

const OFF_VALUES = new Set(["0", "disabled", "false", "none", "off"]);

export type SealTimestampSource = "env" | "settings" | "unset";

export type SealTimestampSetting = {
  /** Where the choice comes from; "unset" is an install from before it. */
  source: SealTimestampSource;
  /** The RFC 3161 server, or null for no timestamp. */
  url: string | null;
};

/** A timestamp server's address, as an http or https URL, or null. */
export function parseTimestampUrl(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 2048) {
    return null;
  }

  try {
    const url = new URL(trimmed);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    if (url.username || url.password) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function isOffValue(value: string): boolean {
  return OFF_VALUES.has(value.trim().toLowerCase());
}

export function resolveSealTimestamp(
  env: EnvSource,
  stored: IntegrationSettings,
): SealTimestampSetting {
  const fromEnv = readEnv(env, "SEAL_TIMESTAMP_URL");

  if (fromEnv !== undefined) {
    // Used as given, as it always was; "off" turns timestamps off.
    return { source: "env", url: isOffValue(fromEnv) ? null : fromEnv };
  }

  const saved = stored["seal.timestampUrl"];

  if (saved === undefined) {
    return { source: "unset", url: null };
  }

  return {
    source: "settings",
    url: isOffValue(saved) ? null : parseTimestampUrl(saved),
  };
}

// --- The seal certificate ---------------------------------------------------

/** What is shown about a certificate. Nothing in it is secret. */
export type SealCertificateSummary = {
  /** SHA-256 of the certificate, as colon-separated hex. */
  fingerprint: string;
  issuer: string;
  /** ISO 8601. */
  notAfter: string;
  /** ISO 8601. */
  notBefore: string;
  selfSigned: boolean;
  subject: string;
};

/**
 * What seal.certificate holds, as JSON. "install" is the install's own
 * self-signed seal; "pkcs12" a file the administrator uploaded, its secret
 * parts in seal.p12 and seal.p12Password. "kms" is planned: a Cloud KMS key
 * version (for an Adobe-trusted, AATL, certificate whose key cannot leave
 * a hardware module) with the certificate issued for it. It is accepted
 * when read, so a later version can store it, but not yet used to seal.
 */
export type StoredSealCertificate =
  | { source: "install" }
  | {
      certificate: SealCertificateSummary;
      source: "pkcs12";
      uploadedAt: number;
    }
  | {
      certificate: SealCertificateSummary | null;
      keyVersion: string;
      source: "kms";
    };

export type SealCertificateSource = StoredSealCertificate["source"];

function isSummary(value: unknown): value is SealCertificateSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.fingerprint === "string" &&
    typeof record.issuer === "string" &&
    typeof record.notAfter === "string" &&
    typeof record.notBefore === "string" &&
    typeof record.selfSigned === "boolean" &&
    typeof record.subject === "string"
  );
}

/**
 * Reads seal.certificate. Anything this version does not understand counts
 * as the install's own seal, so a bad value can never stop sealing.
 */
export function parseStoredSealCertificate(
  raw: string | undefined,
): StoredSealCertificate {
  if (!raw) {
    return { source: "install" };
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) {
      return { source: "install" };
    }

    const record = parsed as Record<string, unknown>;

    if (record.source === "pkcs12" && isSummary(record.certificate)) {
      return {
        certificate: record.certificate,
        source: "pkcs12",
        uploadedAt:
          typeof record.uploadedAt === "number" ? record.uploadedAt : 0,
      };
    }

    if (record.source === "kms" && typeof record.keyVersion === "string") {
      return {
        certificate: isSummary(record.certificate) ? record.certificate : null,
        keyVersion: record.keyVersion,
        source: "kms",
      };
    }
  } catch {
    // Treated as the default below.
  }

  return { source: "install" };
}

export type ResolvedSealCertificate =
  | { bundleBase64: string; kind: "environment"; password: string }
  | {
      bundleBase64: string;
      kind: "pkcs12";
      password: string;
      summary: SealCertificateSummary;
    }
  | {
      kind: "install";
      /** Why the chosen certificate is not used, when one was chosen. */
      problem: string | null;
    };

/** Which certificate seals now: the environment's, the uploaded one, or the install's own. */
export function resolveSealCertificate(
  env: EnvSource,
  stored: IntegrationSettings,
  now: number = Date.now(),
): ResolvedSealCertificate {
  const fromEnv = readEnv(env, "SEAL_P12_BASE64");

  if (fromEnv) {
    return {
      bundleBase64: fromEnv,
      kind: "environment",
      password: readEnv(env, "SEAL_P12_PASSWORD") ?? "",
    };
  }

  const choice = parseStoredSealCertificate(stored["seal.certificate"]);

  if (choice.source === "kms") {
    return {
      kind: "install",
      problem:
        "Cloud KMS keys are not supported by this version yet, so the install's own seal is used.",
    };
  }

  if (choice.source !== "pkcs12") {
    return { kind: "install", problem: null };
  }

  const bundle = stored["seal.p12"];

  if (!bundle) {
    return {
      kind: "install",
      problem:
        "The uploaded certificate can no longer be read (the auth secret changed). Upload it again.",
    };
  }

  const notAfter = Date.parse(choice.certificate.notAfter);

  if (Number.isFinite(notAfter) && notAfter <= now) {
    return {
      kind: "install",
      problem: `The uploaded certificate expired on ${choice.certificate.notAfter.slice(0, 10)}. Upload a new one.`,
    };
  }

  return {
    bundleBase64: bundle,
    kind: "pkcs12",
    password: stored["seal.p12Password"] ?? "",
    summary: choice.certificate,
  };
}

function describeName(name: string): string {
  return name
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/** The parts of a certificate shown in Settings and kept with the choice. */
export function summarizeCertificate(pem: string): SealCertificateSummary {
  const certificate = new X509Certificate(pem);

  return {
    fingerprint: certificate.fingerprint256,
    issuer: describeName(certificate.issuer),
    notAfter: new Date(certificate.validTo).toISOString(),
    notBefore: new Date(certificate.validFrom).toISOString(),
    selfSigned: certificate.issuer === certificate.subject,
    subject: describeName(certificate.subject),
  };
}

// --- First-run setup -------------------------------------------------------

/**
 * Chooses DigiCert's free timestamp server for a new install, inside
 * first-run setup's transaction, and records it in the audit trail as the
 * new administrator's setup. Leaves a choice already stored alone. Only a
 * fresh install gets this: one claimed from before keeps sealing as it
 * did until an administrator chooses.
 */
export async function storeDefaultTimestampServer(
  database: DbExecutor,
  actor: { email: string; id: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const inserted = await database.query(
    `
      INSERT INTO public.integration_settings (key, value, secret, updated_at, updated_by)
      VALUES ('seal.timestampUrl', $1, false, $2, $3)
      ON CONFLICT (key) DO NOTHING
    `,
    [DEFAULT_TIMESTAMP_URL, now, actor.id],
  );

  if (inserted.rowCount === 1) {
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.id,
        event: "settings_changed",
        metadata: {
          area: "seal",
          changes: {
            "seal.timestampUrl": { from: null, to: DEFAULT_TIMESTAMP_URL },
          },
          reason: "first-run setup default",
        },
      },
      database,
    );
  }
}

// --- Reading ---------------------------------------------------------------

/**
 * The stored settings the seal reads: from the given database, or the
 * cached ones. With no database configured at all there are none.
 */
export async function readSealSettings(
  env: EnvSource,
  database?: DbExecutor,
): Promise<IntegrationSettings> {
  if (database) {
    return readIntegrationSettings(database, env);
  }

  if (!resolveDatabaseUrl(env)) {
    return {};
  }

  return getIntegrationSettings(env);
}

/**
 * The timestamp server seals use now, or null. The environment is read
 * first, so with SEAL_TIMESTAMP_URL set the database is not asked. A
 * failure to read the settings seals without a timestamp, as a timestamp
 * server that is down does.
 */
export async function getSealTimestampUrl(
  env: EnvSource = process.env,
  { database }: { database?: DbExecutor } = {},
): Promise<string | null> {
  if (readEnv(env, "SEAL_TIMESTAMP_URL") !== undefined) {
    return resolveSealTimestamp(env, {}).url;
  }

  try {
    return resolveSealTimestamp(env, await readSealSettings(env, database)).url;
  } catch (error) {
    console.warn(
      "[seal] Could not read the timestamp setting; sealing without a timestamp.",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
