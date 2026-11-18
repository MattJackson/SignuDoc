import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TIMESTAMP_URL,
  getSealTimestampUrl,
  parseStoredSealCertificate,
  parseTimestampUrl,
  resolveSealCertificate,
  resolveSealTimestamp,
} from "./seal-settings.ts";

// Which timestamp server and which certificate the seal uses: the
// environment wins, then what an administrator stored, and an install from
// before the setting keeps sealing as it did.

const summary = {
  fingerprint: "AA:BB:CC",
  issuer: "CN=Example Issuing CA, O=Example Trust",
  notAfter: "2030-01-01T00:00:00.000Z",
  notBefore: "2025-01-01T00:00:00.000Z",
  selfSigned: false,
  subject: "CN=Example Inc document seal, O=Example Inc",
};
const uploaded = JSON.stringify({
  certificate: summary,
  source: "pkcs12",
  uploadedAt: 1_800_000_000,
});
const NOW = Date.parse("2027-06-01T00:00:00Z");

test("the timestamp server in the environment wins over what is stored", () => {
  assert.deepEqual(
    resolveSealTimestamp(
      { SEAL_TIMESTAMP_URL: "https://tsa.example.test/" },
      { "seal.timestampUrl": "off" },
    ),
    { source: "env", url: "https://tsa.example.test/" },
  );
  // "off" in the environment turns it off and fixes that too.
  assert.deepEqual(
    resolveSealTimestamp(
      { SEAL_TIMESTAMP_URL: "off" },
      { "seal.timestampUrl": DEFAULT_TIMESTAMP_URL },
    ),
    { source: "env", url: null },
  );
});

test("what is stored is used without the environment", () => {
  assert.deepEqual(
    resolveSealTimestamp({}, { "seal.timestampUrl": DEFAULT_TIMESTAMP_URL }),
    { source: "settings", url: "http://timestamp.digicert.com/" },
  );
  assert.deepEqual(resolveSealTimestamp({}, { "seal.timestampUrl": "off" }), {
    source: "settings",
    url: null,
  });
});

test("an install with nothing stored (set up before the setting) seals without a timestamp", () => {
  assert.deepEqual(resolveSealTimestamp({}, {}), {
    source: "unset",
    url: null,
  });
});

test("the timestamp setting is read without the database when the environment sets it", async () => {
  // No DATABASE_URL: reading the settings would fail, and is not tried.
  assert.equal(
    await getSealTimestampUrl({
      SEAL_TIMESTAMP_URL: "https://tsa.example.test",
    }),
    "https://tsa.example.test",
  );
  assert.equal(await getSealTimestampUrl({ SEAL_TIMESTAMP_URL: "off" }), null);
  assert.equal(await getSealTimestampUrl({}), null);
});

test("only http and https addresses are timestamp servers", () => {
  assert.equal(
    parseTimestampUrl(" http://timestamp.digicert.com "),
    "http://timestamp.digicert.com/",
  );
  assert.equal(parseTimestampUrl("ftp://tsa.example.test"), null);
  assert.equal(parseTimestampUrl("javascript:alert(1)"), null);
  assert.equal(parseTimestampUrl("https://user:pass@tsa.example.test"), null);
  assert.equal(parseTimestampUrl("not a url"), null);
});

test("the certificate in the environment wins over an uploaded one", () => {
  assert.deepEqual(
    resolveSealCertificate(
      { SEAL_P12_BASE64: "ZW52", SEAL_P12_PASSWORD: "pw" },
      { "seal.certificate": uploaded, "seal.p12": "c3RvcmVk" },
      NOW,
    ),
    { bundleBase64: "ZW52", kind: "environment", password: "pw" },
  );
});

test("an uploaded certificate seals while it is readable and valid", () => {
  assert.deepEqual(
    resolveSealCertificate(
      {},
      {
        "seal.certificate": uploaded,
        "seal.p12": "c3RvcmVk",
        "seal.p12Password": "secret",
      },
      NOW,
    ),
    {
      bundleBase64: "c3RvcmVk",
      kind: "pkcs12",
      password: "secret",
      summary,
    },
  );

  const expired = resolveSealCertificate(
    {},
    { "seal.certificate": uploaded, "seal.p12": "c3RvcmVk" },
    Date.parse("2031-01-01T00:00:00Z"),
  );

  assert.equal(expired.kind, "install");
  assert.match(
    expired.kind === "install" ? (expired.problem ?? "") : "",
    /expired on 2030-01-01/,
  );

  // The file no longer decrypts, so it is not among the stored settings.
  const unreadable = resolveSealCertificate(
    {},
    { "seal.certificate": uploaded },
    NOW,
  );

  assert.equal(unreadable.kind, "install");
  assert.match(
    unreadable.kind === "install" ? (unreadable.problem ?? "") : "",
    /Upload it again/,
  );
});

test("the install's own certificate is the default, and anything unknown falls back to it", () => {
  assert.deepEqual(resolveSealCertificate({}, {}, NOW), {
    kind: "install",
    problem: null,
  });
  assert.deepEqual(parseStoredSealCertificate("not json"), {
    source: "install",
  });
  assert.deepEqual(
    parseStoredSealCertificate(JSON.stringify({ source: "hsm-of-the-future" })),
    { source: "install" },
  );
  assert.deepEqual(
    parseStoredSealCertificate(JSON.stringify({ source: "install" })),
    { source: "install" },
  );
});

test("a Cloud KMS choice can be stored already, and seals with the install's own certificate until it is supported", () => {
  const kms = JSON.stringify({
    certificate: null,
    keyVersion:
      "projects/p/locations/global/keyRings/r/cryptoKeys/seal/cryptoKeyVersions/1",
    source: "kms",
  });

  assert.equal(parseStoredSealCertificate(kms).source, "kms");

  const resolved = resolveSealCertificate({}, { "seal.certificate": kms }, NOW);

  assert.equal(resolved.kind, "install");
  assert.match(
    resolved.kind === "install" ? (resolved.problem ?? "") : "",
    /Cloud KMS/,
  );
});
