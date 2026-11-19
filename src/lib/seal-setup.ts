import { X509Certificate, randomBytes, createHash } from "node:crypto";

import forge from "node-forge";

import {
  getIntegrationSettings,
  readIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "./integration-settings.ts";
import { readCms } from "./services/pdf-ltv.ts";
import {
  PdfSealError,
  requestDocumentTimestamp,
  sealIdentityFromPkcs12,
  type SealIdentity,
} from "./services/pdf-seal.ts";
import { getSealIdentity } from "./services/seal-identity.ts";
import {
  DEFAULT_TIMESTAMP_URL,
  isOffValue,
  parseStoredSealCertificate,
  parseTimestampUrl,
  resolveSealCertificate,
  resolveSealTimestamp,
  summarizeCertificate,
  type SealCertificateSummary,
  type SealTimestampSource,
  type StoredSealCertificate,
} from "./seal-settings.ts";
import { getSettings } from "./settings.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// The "Seal & timestamp" part of Settings and of onboarding: what the
// administrator sees about the seal (seal-settings.ts decides what is used),
// saving a choice, checking an uploaded certificate, trying a timestamp
// server, and the certificate to hand out so company computers trust the
// seal. Every change goes through saveIntegrationSettings, which records it
// in the install's audit trail without any secret value.

/** The largest .p12 or .pfx accepted. Real ones are a few kilobytes. */
const MAX_PKCS12_BYTES = 64 * 1024;

export class SealSettingsError extends Error {
  fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "SealSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

export type SealSettingsView = {
  certificate: {
    /** The certificate sealing now, when it could be read. */
    active: SealCertificateSummary | null;
    /** Set by SEAL_P12_BASE64, so it cannot be changed here. */
    locked: boolean;
    /** Why the chosen certificate is not the one sealing, when it is not. */
    problem: string | null;
    /** What is chosen: the environment's, the install's own, or a file. */
    source: "environment" | StoredSealCertificate["source"];
    /** The uploaded file's certificate, while one is kept. */
    uploaded: SealCertificateSummary | null;
  };
  part11Mode: boolean;
  timestamp: {
    defaultUrl: string;
    /** Set by SEAL_TIMESTAMP_URL, so it cannot be changed here. */
    locked: boolean;
    source: SealTimestampSource;
    /** The server used now, or null for none. */
    url: string | null;
  };
};

/** What Settings shows. Never includes a key, a file or a password. */
export async function getSealSettingsView(
  env: EnvSource = process.env,
  stored?: IntegrationSettings,
): Promise<SealSettingsView> {
  const settings = stored ?? (await getIntegrationSettings(env));
  const [appSettings, active] = await Promise.all([
    getSettings(env),
    getSealIdentity({ env })
      .then((identity) =>
        summarizeCertificate(identity.certificateChainPem[0]!),
      )
      .catch((error: unknown) => {
        console.warn(
          "[seal] The seal certificate could not be loaded for Settings:",
          error instanceof Error ? error.message : error,
        );
        return null;
      }),
  ]);

  return buildSealSettingsView(env, settings, {
    active,
    part11Mode: appSettings.part11Mode,
  });
}

/** The view from what is stored, with what had to be loaded given. */
export function buildSealSettingsView(
  env: EnvSource,
  stored: IntegrationSettings,
  {
    active,
    now = Date.now(),
    part11Mode,
  }: {
    active: SealCertificateSummary | null;
    now?: number;
    part11Mode: boolean;
  },
): SealSettingsView {
  const timestamp = resolveSealTimestamp(env, stored);
  const resolved = resolveSealCertificate(env, stored, now);
  const choice = parseStoredSealCertificate(stored["seal.certificate"]);

  return {
    certificate: {
      active,
      locked: resolved.kind === "environment",
      problem: resolved.kind === "install" ? resolved.problem : null,
      source: resolved.kind === "environment" ? "environment" : choice.source,
      uploaded:
        choice.source === "pkcs12" && stored["seal.p12"]
          ? choice.certificate
          : null,
    },
    part11Mode,
    timestamp: {
      defaultUrl: DEFAULT_TIMESTAMP_URL,
      locked: timestamp.source === "env",
      source: timestamp.source,
      url: timestamp.url,
    },
  };
}

// --- Checking an uploaded certificate ---------------------------------------

export type CheckedPkcs12 = {
  identity: SealIdentity;
  summary: SealCertificateSummary;
};

/**
 * Opens an uploaded .p12 or .pfx and checks it can seal: it opens with the
 * password, holds an RSA private key and the certificate for it, and the
 * certificate is valid now. Says what is wrong in words an administrator
 * can act on.
 */
export function checkPkcs12(
  bundleBase64: string,
  password: string,
  now: number = Date.now(),
): CheckedPkcs12 {
  const cleaned = bundleBase64.replace(/\s+/g, "");

  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new SealSettingsError("Choose a .p12 or .pfx file.", {
      file: "Choose a .p12 or .pfx file.",
    });
  }

  const bytes = Buffer.from(cleaned, "base64");

  if (bytes.length === 0 || bytes.length > MAX_PKCS12_BYTES) {
    throw new SealSettingsError("That file is too large to be a .p12 file.", {
      file: "That file is too large to be a .p12 file.",
    });
  }

  let identity: SealIdentity;

  try {
    identity = sealIdentityFromPkcs12(
      new Uint8Array(bytes),
      password,
      "The file",
    );
  } catch (error) {
    const message =
      error instanceof PdfSealError
        ? error.message
        : "The file could not be opened. Check that it is a .p12 or .pfx file and that the password is right.";

    throw new SealSettingsError(message, { file: message });
  }

  const summary = summarizeCertificate(identity.certificateChainPem[0]!);

  if (Date.parse(summary.notBefore) > now) {
    const message = `The certificate is not valid until ${summary.notBefore.slice(0, 10)}.`;

    throw new SealSettingsError(message, { file: message });
  }

  if (Date.parse(summary.notAfter) <= now) {
    const message = `The certificate expired on ${summary.notAfter.slice(0, 10)}.`;

    throw new SealSettingsError(message, { file: message });
  }

  return { identity, summary };
}

// --- Saving --------------------------------------------------------------

export type SealSettingsInput = {
  certificate?:
    | { source: "install" }
    | {
        /** The file in base64; left out to keep the one already uploaded. */
        file?: string;
        password?: string;
        source: "pkcs12";
      };
  timestamp?: { enabled: boolean; url?: string };
};

function readInput(body: unknown): SealSettingsInput {
  if (typeof body !== "object" || body === null) {
    throw new SealSettingsError("Nothing to save.");
  }

  const record = body as Record<string, unknown>;
  const input: SealSettingsInput = {};

  if (record.timestamp !== undefined) {
    const timestamp = record.timestamp as Record<string, unknown> | null;

    if (
      typeof timestamp !== "object" ||
      timestamp === null ||
      typeof timestamp.enabled !== "boolean" ||
      (timestamp.url !== undefined && typeof timestamp.url !== "string")
    ) {
      throw new SealSettingsError("The timestamp setting is not readable.");
    }

    input.timestamp = {
      enabled: timestamp.enabled,
      url: timestamp.url as string | undefined,
    };
  }

  if (record.certificate !== undefined) {
    const certificate = record.certificate as Record<string, unknown> | null;

    if (typeof certificate !== "object" || certificate === null) {
      throw new SealSettingsError("The certificate setting is not readable.");
    }

    if (certificate.source === "install") {
      input.certificate = { source: "install" };
    } else if (certificate.source === "pkcs12") {
      if (
        (certificate.file !== undefined &&
          typeof certificate.file !== "string") ||
        (certificate.password !== undefined &&
          typeof certificate.password !== "string")
      ) {
        throw new SealSettingsError("The certificate setting is not readable.");
      }

      input.certificate = {
        file: certificate.file as string | undefined,
        password: certificate.password as string | undefined,
        source: "pkcs12",
      };
    } else if (certificate.source === "kms") {
      throw new SealSettingsError(
        "Cloud KMS keys are planned and cannot be chosen yet.",
      );
    } else {
      throw new SealSettingsError(
        "Choose where the seal certificate comes from.",
      );
    }
  }

  return input;
}

/**
 * The change to store for the given input, checked against what is stored
 * and what the environment fixes. Pure, so it can be tested without a
 * database.
 */
export function planSealSettingsUpdate(
  body: unknown,
  env: EnvSource,
  stored: IntegrationSettings,
  now: number = Date.now(),
): IntegrationSettingsUpdate {
  const input = readInput(body);
  const update: IntegrationSettingsUpdate = {};

  if (input.timestamp) {
    if (readEnv(env, "SEAL_TIMESTAMP_URL") !== undefined) {
      throw new SealSettingsError(
        "The timestamp server is set by SEAL_TIMESTAMP_URL, so it cannot be changed here.",
      );
    }

    if (!input.timestamp.enabled) {
      update["seal.timestampUrl"] = "off";
    } else {
      const raw = input.timestamp.url?.trim() || DEFAULT_TIMESTAMP_URL;
      const url = isOffValue(raw) ? null : parseTimestampUrl(raw);

      if (!url) {
        throw new SealSettingsError("Check the timestamp server.", {
          timestampUrl:
            "Enter the server's address, starting with http:// or https://.",
        });
      }

      update["seal.timestampUrl"] = url;
    }
  }

  if (input.certificate) {
    if (readEnv(env, "SEAL_P12_BASE64")) {
      throw new SealSettingsError(
        "The seal certificate is set by SEAL_P12_BASE64, so it cannot be changed here.",
      );
    }

    if (input.certificate.source === "install") {
      const choice: StoredSealCertificate = { source: "install" };

      // The uploaded key is not kept once it is not used.
      update["seal.certificate"] = JSON.stringify(choice);
      update["seal.p12"] = null;
      update["seal.p12Password"] = null;
    } else if (input.certificate.file) {
      const password = input.certificate.password ?? "";
      const checked = checkPkcs12(input.certificate.file, password, now);
      const choice: StoredSealCertificate = {
        certificate: checked.summary,
        source: "pkcs12",
        uploadedAt: Math.floor(now / 1000),
      };

      update["seal.certificate"] = JSON.stringify(choice);
      update["seal.p12"] = input.certificate.file.replace(/\s+/g, "");
      update["seal.p12Password"] = password === "" ? null : password;
    } else {
      // Keeping the file already uploaded: only valid while there is one.
      const current = resolveSealCertificate(env, stored, now);

      if (current.kind !== "pkcs12") {
        throw new SealSettingsError("Choose the .p12 or .pfx file.", {
          file: "Choose the .p12 or .pfx file.",
        });
      }
    }
  }

  return update;
}

/** Saves the administrator's choice, and returns the view after it. */
export async function saveSealSettings(
  body: unknown,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<SealSettingsView> {
  const stored = await readIntegrationSettings(undefined, env);
  const update = planSealSettingsUpdate(body, env, stored);
  const saved =
    Object.keys(update).length > 0
      ? await saveIntegrationSettings(update, actor, { area: "seal", env })
      : stored;

  return getSealSettingsView(env, saved);
}

// --- Trying a timestamp server ------------------------------------------

export type TimestampTestResult =
  | {
      /** The time-stamping authority's certificate subject, when sent. */
      authority: string | null;
      ok: true;
      /** The time the server put in its token, ISO 8601. */
      time: string | null;
      url: string;
    }
  | { message: string; ok: false; url: string | null };

/** The genTime of an RFC 3161 token (a CMS ContentInfo), or null. */
export function readTimestampTime(token: Buffer): string | null {
  try {
    const asn1 = forge.asn1;
    const contentInfo = asn1.fromDer(token.toString("binary"));
    const signedData = (
      (contentInfo.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[]
    )[0]!;
    const encapsulated = (signedData.value as forge.asn1.Asn1[])[2]!;
    const octets = (
      (encapsulated.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[]
    )[0]!;
    const tstInfo = asn1.fromDer(octets.value as string);
    const genTime = (tstInfo.value as forge.asn1.Asn1[])[4]!;

    return asn1.generalizedTimeToDate(genTime.value as string).toISOString();
  } catch {
    return null;
  }
}

function readTimestampAuthority(token: Buffer): string | null {
  try {
    const certificates = readCms(token).certificates.map(
      (der) => new X509Certificate(der),
    );
    const authority =
      certificates.find((certificate) => !certificate.ca) ?? certificates[0];

    return authority
      ? authority.subject
          .split("\n")
          .map((part) => part.trim())
          .filter(Boolean)
          .join(", ")
      : null;
  } catch {
    return null;
  }
}

/**
 * Asks a timestamp server for a real RFC 3161 token over the hash of a
 * throwaway value, and says whether it answered properly. With no address
 * given, the one sealing uses now (or DigiCert's, when there is none).
 */
export async function testTimestampServer(
  given: string | null | undefined,
  {
    env = process.env,
    stored,
  }: { env?: EnvSource; stored?: IntegrationSettings } = {},
): Promise<TimestampTestResult> {
  let url: string | null;

  if (given?.trim()) {
    url = parseTimestampUrl(given);

    if (!url) {
      return {
        message:
          "That is not a server address. It starts with http:// or https://.",
        ok: false,
        url: null,
      };
    }
  } else {
    const current = resolveSealTimestamp(
      env,
      stored ?? (await getIntegrationSettings(env)),
    );

    url = current.url ?? DEFAULT_TIMESTAMP_URL;
  }

  const digest = createHash("sha256").update(randomBytes(32)).digest();

  try {
    const token = await requestDocumentTimestamp(digest, url);

    return {
      authority: readTimestampAuthority(token),
      ok: true,
      time: readTimestampTime(token),
      url,
    };
  } catch (error) {
    return {
      message:
        error instanceof PdfSealError
          ? error.message
          : "The timestamp server could not be asked.",
      ok: false,
      url,
    };
  }
}

// --- The certificate to hand out --------------------------------------------

export type SealCertificateDownload = {
  body: Uint8Array;
  contentType: string;
  fileName: string;
};

/**
 * The certificate sealing now, as PEM or as DER (.cer), for an
 * administrator to distribute to company computers (MDM or endpoint
 * management) so PDF readers there trust the seal. The certificate is in
 * every sealed PDF anyway; nothing secret is in it.
 */
export async function getSealCertificateDownload(
  format: "cer" | "pem",
  env: EnvSource = process.env,
): Promise<SealCertificateDownload> {
  const identity = await getSealIdentity({ env });
  const pem = identity.certificateChainPem[0]!;
  const certificate = new X509Certificate(pem);
  const name =
    (
      certificate.subject
        .split("\n")
        .find((part) => part.startsWith("CN="))
        ?.slice(3) ?? "seal"
    )
      .replace(/[^A-Za-z0-9 ._-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "seal";

  return format === "pem"
    ? {
        body: new TextEncoder().encode(certificate.toString()),
        contentType: "application/x-pem-file",
        fileName: `${name}.pem`,
      }
    : {
        body: new Uint8Array(certificate.raw),
        contentType: "application/pkix-cert",
        fileName: `${name}.cer`,
      };
}
