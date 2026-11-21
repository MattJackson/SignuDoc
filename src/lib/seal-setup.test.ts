import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import forge from "node-forge";

import {
  buildSealSettingsView,
  checkPkcs12,
  planSealSettingsUpdate,
  SealSettingsError,
  testTimestampServer,
} from "./seal-setup.ts";
import { DEFAULT_TIMESTAMP_URL } from "./seal-settings.ts";
import { startTestPki } from "./services/pki-test-support.ts";

// The seal part of Settings without a database: an uploaded .p12 is checked
// before it is stored, what is saved follows the environment's locks, and
// "Test timestamp server" asks a real (stand-in) RFC 3161 service.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function makeCertificate(
  keys: { privateKeyPem: string; publicKeyPem: string },
  { from, until }: { from: number; until: number },
): forge.pki.Certificate {
  const certificate = forge.pki.createCertificate();
  const subject = [
    { name: "commonName", value: "Example Inc document seal" },
    { name: "organizationName", value: "Example Inc" },
  ];

  certificate.serialNumber = "01";
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKeyPem);
  certificate.validity.notBefore = new Date(from);
  certificate.validity.notAfter = new Date(until);
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.sign(
    forge.pki.privateKeyFromPem(keys.privateKeyPem),
    forge.md.sha256.create(),
  );

  return certificate;
}

/** A .p12 file in base64, as the browser sends it. */
function makePkcs12({
  certificateKeys,
  from = NOW - DAY,
  keys = makeKeys(),
  password = "correct horse",
  until = NOW + 365 * DAY,
  withKey = true,
}: {
  certificateKeys?: { privateKeyPem: string; publicKeyPem: string };
  from?: number;
  keys?: { privateKeyPem: string; publicKeyPem: string };
  password?: string;
  until?: number;
  withKey?: boolean;
} = {}): string {
  const certificate = makeCertificate(certificateKeys ?? keys, {
    from,
    until,
  });
  const p12 = forge.pkcs12.toPkcs12Asn1(
    withKey ? forge.pki.privateKeyFromPem(keys.privateKeyPem) : null,
    [certificate],
    password,
    { algorithm: "3des" },
  );

  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString(
    "base64",
  );
}

function fieldError(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof SealSettingsError);
    assert.match(error.message, pattern);

    return true;
  });
}

test("a good .p12 opens, and its certificate is described", () => {
  const checked = checkPkcs12(makePkcs12(), "correct horse", NOW);

  assert.match(checked.identity.privateKeyPem, /PRIVATE KEY/);
  assert.match(checked.summary.subject, /CN=Example Inc document seal/);
  assert.equal(checked.summary.selfSigned, true);
  assert.match(checked.summary.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(Date.parse(checked.summary.notAfter) > NOW);
});

test("a .p12 with the wrong password, no key, the wrong key or an expired certificate is refused", () => {
  const bundle = makePkcs12();

  fieldError(
    () => checkPkcs12(bundle, "wrong", NOW),
    /could not be opened.*password/,
  );
  fieldError(
    () => checkPkcs12(makePkcs12({ withKey: false }), "correct horse", NOW),
    /must hold one RSA private key/,
  );
  fieldError(
    () =>
      checkPkcs12(
        makePkcs12({ certificateKeys: makeKeys() }),
        "correct horse",
        NOW,
      ),
    /no certificate that matches its private key/,
  );
  fieldError(
    () =>
      checkPkcs12(
        makePkcs12({ from: NOW - 30 * DAY, until: NOW - DAY }),
        "correct horse",
        NOW,
      ),
    /expired on/,
  );
  fieldError(
    () =>
      checkPkcs12(
        makePkcs12({ from: NOW + DAY, until: NOW + 30 * DAY }),
        "correct horse",
        NOW,
      ),
    /not valid until/,
  );
  fieldError(() => checkPkcs12("not base64 at all!", "", NOW), /Choose/);
});

test("uploading a certificate stores it, its password and a description, all checked", () => {
  const bundle = makePkcs12();
  const update = planSealSettingsUpdate(
    {
      certificate: {
        file: bundle,
        password: "correct horse",
        source: "pkcs12",
      },
    },
    {},
    {},
    NOW,
  );
  const choice = JSON.parse(update["seal.certificate"] ?? "{}") as {
    certificate: { subject: string };
    source: string;
  };

  assert.equal(choice.source, "pkcs12");
  assert.match(choice.certificate.subject, /Example Inc/);
  assert.equal(update["seal.p12"], bundle);
  assert.equal(update["seal.p12Password"], "correct horse");
  // The description, which goes into the audit trail, holds no secret.
  assert.doesNotMatch(update["seal.certificate"] ?? "", /correct horse/);
  assert.doesNotMatch(update["seal.certificate"] ?? "", /PRIVATE KEY/);
});

test("going back to the install's own certificate forgets the uploaded key", () => {
  assert.deepEqual(
    planSealSettingsUpdate({ certificate: { source: "install" } }, {}, {}, NOW),
    {
      "seal.certificate": JSON.stringify({ source: "install" }),
      "seal.p12": null,
      "seal.p12Password": null,
    },
  );
});

test("keeping the uploaded certificate needs one to be there", () => {
  fieldError(
    () =>
      planSealSettingsUpdate(
        { certificate: { source: "pkcs12" } },
        {},
        {},
        NOW,
      ),
    /Choose the .p12/,
  );
});

test("saving without a new file keeps the uploaded certificate", () => {
  const update = planSealSettingsUpdate(
    {
      certificate: {
        file: makePkcs12(),
        password: "correct horse",
        source: "pkcs12",
      },
    },
    {},
    {},
    NOW,
  );

  // Nothing is written, so the certificate and its password stay as stored.
  assert.deepEqual(
    planSealSettingsUpdate(
      { certificate: { source: "pkcs12" } },
      {},
      {
        "seal.certificate": update["seal.certificate"] ?? undefined,
        "seal.p12": update["seal.p12"] ?? undefined,
        "seal.p12Password": update["seal.p12Password"] ?? undefined,
      },
      NOW,
    ),
    {},
  );
});

test("an uploaded certificate with an empty password stores no password", () => {
  const update = planSealSettingsUpdate(
    {
      certificate: {
        file: makePkcs12({ password: "" }),
        password: "",
        source: "pkcs12",
      },
    },
    {},
    {},
    NOW,
  );

  assert.equal(update["seal.p12Password"], null);
  assert.ok(update["seal.p12"]);
});

test("a Cloud KMS key cannot be chosen yet", () => {
  fieldError(
    () =>
      planSealSettingsUpdate({ certificate: { source: "kms" } }, {}, {}, NOW),
    /planned/,
  );
});

test("the timestamp server is saved as a URL or off, defaulting to DigiCert's", () => {
  assert.deepEqual(
    planSealSettingsUpdate({ timestamp: { enabled: false } }, {}, {}, NOW),
    { "seal.timestampUrl": "off" },
  );
  assert.deepEqual(
    planSealSettingsUpdate({ timestamp: { enabled: true } }, {}, {}, NOW),
    { "seal.timestampUrl": "http://timestamp.digicert.com/" },
  );
  assert.deepEqual(
    planSealSettingsUpdate(
      { timestamp: { enabled: true, url: "https://tsa.example.test/rfc3161" } },
      {},
      {},
      NOW,
    ),
    { "seal.timestampUrl": "https://tsa.example.test/rfc3161" },
  );
  fieldError(
    () =>
      planSealSettingsUpdate(
        { timestamp: { enabled: true, url: "file:///etc/passwd" } },
        {},
        {},
        NOW,
      ),
    /Check the timestamp server/,
  );
});

test("what the environment sets cannot be changed in the app", () => {
  fieldError(
    () =>
      planSealSettingsUpdate(
        { timestamp: { enabled: false } },
        { SEAL_TIMESTAMP_URL: "https://tsa.example.test/" },
        {},
        NOW,
      ),
    /SEAL_TIMESTAMP_URL/,
  );
  fieldError(
    () =>
      planSealSettingsUpdate(
        { certificate: { source: "install" } },
        { SEAL_P12_BASE64: "ZW52" },
        {},
        NOW,
      ),
    /SEAL_P12_BASE64/,
  );
});

test("the view shows what is locked and what an older install has not chosen", () => {
  const older = buildSealSettingsView(
    {},
    {},
    { active: null, now: NOW, part11Mode: true },
  );

  assert.equal(older.timestamp.source, "unset");
  assert.equal(older.timestamp.url, null);
  assert.equal(older.timestamp.defaultUrl, DEFAULT_TIMESTAMP_URL);
  assert.equal(older.timestamp.locked, false);
  assert.equal(older.certificate.source, "install");
  assert.equal(older.part11Mode, true);

  const fixed = buildSealSettingsView(
    {
      SEAL_P12_BASE64: "ZW52",
      SEAL_TIMESTAMP_URL: "https://tsa.example.test/",
    },
    { "seal.timestampUrl": "off" },
    { active: null, now: NOW, part11Mode: false },
  );

  assert.equal(fixed.timestamp.locked, true);
  assert.equal(fixed.timestamp.url, "https://tsa.example.test/");
  assert.equal(fixed.certificate.locked, true);
  assert.equal(fixed.certificate.source, "environment");
});

test("testing a timestamp server asks it for a real token and reports the time", async () => {
  const pki = await startTestPki();

  try {
    const result = await testTimestampServer(pki.timestampUrl, { stored: {} });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.url, pki.timestampUrl);

    if (result.ok) {
      assert.ok(result.time, "the token's time is read");
      assert.ok(Math.abs(Date.parse(result.time) - Date.now()) < DAY);
    }

    assert.equal(pki.state.timestampRequests, 1);
  } finally {
    await pki.close();
  }
});

test("with no address given, the test asks the server sealing uses now", async () => {
  const pki = await startTestPki();

  try {
    const result = await testTimestampServer(undefined, {
      env: {},
      stored: { "seal.timestampUrl": pki.timestampUrl },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.url, pki.timestampUrl);
  } finally {
    await pki.close();
  }
});

test("a server that refuses, or is not there, is reported in words", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${String(port)}/`;

  try {
    const refused = await testTimestampServer(url, { stored: {} });

    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.message, /answered 500/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const gone = await testTimestampServer(url, { stored: {} });

  assert.equal(gone.ok, false);
  assert.match(gone.ok ? "" : gone.message, /could not be reached/);

  const nonsense = await testTimestampServer("ftp://example.test", {
    stored: {},
  });

  assert.equal(nonsense.ok, false);
  assert.equal(nonsense.url, null);
});
