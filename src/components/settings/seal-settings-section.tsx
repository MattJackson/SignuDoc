"use client";

import { useRef, useState, type ChangeEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { SealSettingsView, TimestampTestResult } from "@/lib/seal-setup";
import type { SealCertificateSummary } from "@/lib/seal-settings";

// The Seal & timestamp section of Settings, for the administrator: the
// timestamp server that adds a trusted time to every seal (with a test),
// the certificate finished documents are sealed with (the install's own,
// or an uploaded .p12 or .pfx file), and the certificate to hand out so
// company computers trust the seal. What the deployment sets in the
// environment is shown and cannot be changed here. Self-contained, so
// onboarding shows it as its "Seal & timestamp" step.

type CertificateChoice = "install" | "pkcs12";

type Notice = {
  message: string;
  tone: "danger" | "success" | "warning";
} | null;

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

function formatDate(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";

  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

function CertificateDetails({
  certificate,
}: {
  certificate: SealCertificateSummary;
}) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm leading-6 sm:grid-cols-[auto_1fr]">
      <dt className="font-semibold text-(--fg)">Issued to</dt>
      <dd className="break-words text-(--secondary)">{certificate.subject}</dd>
      <dt className="font-semibold text-(--fg)">Issued by</dt>
      <dd className="break-words text-(--secondary)">
        {certificate.selfSigned ? "Itself (self-signed)" : certificate.issuer}
      </dd>
      <dt className="font-semibold text-(--fg)">Valid until</dt>
      <dd className="text-(--secondary)">{formatDate(certificate.notAfter)}</dd>
      <dt className="font-semibold text-(--fg)">SHA-256</dt>
      <dd className="break-all font-mono text-xs leading-6 text-(--secondary)">
        {certificate.fingerprint}
      </dd>
    </dl>
  );
}

export function SealSettingsSection({
  initialView,
  onChange,
}: {
  initialView: SealSettingsView;
  /** Called after a save, so onboarding can read its checklist again. */
  onChange?: () => void;
}) {
  const [view, setView] = useState(initialView);
  // An install from before this setting keeps sealing as it did until the
  // administrator ticks the box; nothing is turned on by saving something
  // else here.
  const [timestampOn, setTimestampOn] = useState(
    initialView.timestamp.url !== null,
  );
  const [timestampUrl, setTimestampUrl] = useState(
    initialView.timestamp.url ?? initialView.timestamp.defaultUrl,
  );
  const [choice, setChoice] = useState<CertificateChoice>(
    initialView.certificate.source === "pkcs12" ? "pkcs12" : "install",
  );
  const [file, setFile] = useState<{ base64: string; name: string } | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [testResult, setTestResult] = useState<TimestampTestResult | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending !== null;
  const timestampLocked = view.timestamp.locked;
  const certificateLocked = view.certificate.locked;
  const savedChoice: CertificateChoice =
    view.certificate.source === "pkcs12" ? "pkcs12" : "install";

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];

    event.target.value = "";

    if (!chosen) {
      return;
    }

    setErrors((current) => ({ ...current, file: "" }));
    setFile({
      base64: toBase64(await chosen.arrayBuffer()),
      name: chosen.name,
    });
  }

  async function save() {
    setPending("save");
    setNotice(null);
    setErrors({});

    const body: Record<string, unknown> = {};

    // An install from before the setting stays as it is unless the box
    // was ticked.
    if (
      !timestampLocked &&
      (timestampOn || view.timestamp.source !== "unset")
    ) {
      body.timestamp = { enabled: timestampOn, url: timestampUrl };
    }

    // The certificate is only sent when it changes, so saving the
    // timestamp alone never asks for the file again.
    if (!certificateLocked && (choice !== savedChoice || file)) {
      body.certificate =
        choice === "install"
          ? { source: "install" }
          : { file: file?.base64, password, source: "pkcs12" };
    }

    try {
      const response = await fetch("/api/admin/seal", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        view?: SealSettingsView;
      } | null;

      if (!response.ok || !payload?.view) {
        setErrors(payload?.fieldErrors ?? {});
        setNotice({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "danger",
        });
        return;
      }

      setView(payload.view);
      setFile(null);
      setPassword("");
      setTimestampOn(payload.view.timestamp.url !== null);
      setTimestampUrl(
        payload.view.timestamp.url ?? payload.view.timestamp.defaultUrl,
      );
      setNotice({
        message:
          "Saved. Documents sealed from now on use these settings; documents sealed before keep their own seal and still verify.",
        tone: "success",
      });
      onChange?.();
    } catch {
      setNotice({ message: GENERIC_ERROR_MESSAGE, tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  async function testTimestamp() {
    setPending("test");
    setTestResult(null);

    try {
      const response = await fetch("/api/admin/seal", {
        body: JSON.stringify({
          action: "test_timestamp",
          url: timestampLocked ? undefined : timestampUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        result?: TimestampTestResult;
      } | null;

      setTestResult(
        payload?.result ?? {
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          ok: false,
          url: null,
        },
      );
    } catch {
      setTestResult({ message: GENERIC_ERROR_MESSAGE, ok: false, url: null });
    } finally {
      setPending(null);
    }
  }

  const certificateOptions: Array<{
    description: string;
    disabled?: boolean;
    label: string;
    value: CertificateChoice | "kms";
  }> = [
    {
      description:
        "Made by this install the first time it seals. Any change to a document shows in a PDF reader; readers call the signer unknown until the certificate is trusted on that computer (see below).",
      label: "This install's own certificate",
      value: "install",
    },
    {
      description:
        "A document-signing certificate from a certificate authority, as a .p12 or .pfx file with its password. Kept encrypted. Readers that trust the authority show your organization's name as verified.",
      label: "Upload a certificate file",
      value: "pkcs12",
    },
    {
      description:
        "Planned: seal with a key held in Google Cloud KMS, which Adobe-trusted (AATL) certificates need, since their keys must stay in a hardware module. Not available yet.",
      disabled: true,
      label: "Cloud KMS key (for Adobe-trusted / AATL certificates)",
      value: "kms",
    },
  ];

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      data-testid="seal-settings"
      id="seal"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Seal &amp; timestamp
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Every finished document and certificate is sealed, so any later
            change shows in a PDF reader. A timestamp server adds a trusted time
            to the seal and keeps it checkable for years (long-term validation).
          </p>
        </div>

        {view.part11Mode ? (
          <p className="notice notice-warning" role="status">
            Part 11 mode is on. A change here is a change to a validated system:
            follow your change-control procedure. Every change is recorded in
            the audit trail.
          </p>
        ) : null}

        <fieldset className="space-y-4" disabled={busy || timestampLocked}>
          <legend className="pb-2 text-base font-extrabold text-(--fg)">
            Timestamp server
          </legend>
          {timestampLocked ? (
            <p className="text-sm leading-6 text-(--secondary)">
              Set by the deployment (SEAL_TIMESTAMP_URL), so it cannot be
              changed here:{" "}
              <code className="break-all text-(--fg)">
                {view.timestamp.url ?? "off"}
              </code>
              .
            </p>
          ) : view.timestamp.source === "unset" ? (
            <p className="notice notice-warning" role="status">
              This install has sealed without a trusted time so far. Tick the
              box below to give each seal an independent time and long-term
              validation; DigiCert&apos;s free server is filled in. Nothing
              changes until you save.
            </p>
          ) : null}
          {!timestampLocked ? (
            <>
              <label className="flex items-center gap-3 text-sm font-semibold text-(--fg)">
                <input
                  checked={timestampOn}
                  className="size-4 accent-(--accent)"
                  onChange={(event) => setTimestampOn(event.target.checked)}
                  type="checkbox"
                />
                Add a trusted time to every seal
              </label>
              {timestampOn ? (
                <div className="max-w-xl">
                  <FieldShell
                    disabled={busy}
                    error={errors.timestampUrl}
                    helper={`An RFC 3161 timestamp server. ${view.timestamp.defaultUrl} is DigiCert's, free to use.`}
                    label="Server address"
                    name="seal-timestamp-url"
                    onChange={(event) => {
                      setTimestampUrl(event.target.value);
                      setTestResult(null);
                    }}
                    placeholder={view.timestamp.defaultUrl}
                    readOnly={false}
                    value={timestampUrl}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </fieldset>
        <div className="space-y-3">
          <ShellButton
            disabled={
              busy ||
              (timestampLocked ? view.timestamp.url === null : !timestampOn)
            }
            loading={pending === "test"}
            onClick={() => void testTimestamp()}
            variant="secondary"
          >
            {pending === "test" ? "Asking..." : "Test timestamp server"}
          </ShellButton>
          {testResult ? (
            <p
              className={`notice ${testResult.ok ? "notice-success" : "notice-danger"}`}
              role={testResult.ok ? "status" : "alert"}
            >
              {testResult.ok
                ? `${testResult.url} answered with a valid timestamp${testResult.time ? ` for ${new Date(testResult.time).toLocaleString()}` : ""}${testResult.authority ? `, signed by ${testResult.authority}` : ""}.`
                : `${testResult.url ? `${testResult.url}: ` : ""}${testResult.message}`}
            </p>
          ) : null}
        </div>

        <fieldset
          className="space-y-3 border-t border-(--border) pt-6"
          disabled={busy || certificateLocked}
        >
          <legend className="pb-2 text-base font-extrabold text-(--fg)">
            Seal certificate
          </legend>
          {certificateLocked ? (
            <p className="text-sm leading-6 text-(--secondary)">
              Set by the deployment (SEAL_P12_BASE64 and SEAL_P12_PASSWORD), so
              it cannot be changed here.
            </p>
          ) : null}
          {view.certificate.problem ? (
            <p className="notice notice-danger" role="alert">
              {view.certificate.problem}
            </p>
          ) : null}
          {!certificateLocked
            ? certificateOptions.map((option) => (
                <label
                  className={`flex items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent) ${option.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                  key={option.value}
                >
                  <input
                    checked={choice === option.value}
                    className="mt-1 size-4 accent-(--accent)"
                    disabled={option.disabled}
                    name="seal-certificate"
                    onChange={() => {
                      if (option.value !== "kms") {
                        setChoice(option.value);
                      }
                    }}
                    type="radio"
                    value={option.value}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-bold text-(--fg)">
                      {option.label}
                    </span>
                    <span className="block text-sm leading-6 text-(--secondary)">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))
            : null}
          {!certificateLocked && choice === "pkcs12" ? (
            <div className="max-w-xl space-y-4">
              {view.certificate.uploaded && !file ? (
                <p className="text-sm leading-6 text-(--secondary)">
                  A certificate is uploaded. Choose another file only to replace
                  it.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  accept=".p12,.pfx,application/x-pkcs12"
                  aria-label="Certificate file"
                  className="hidden"
                  onChange={(event) => void chooseFile(event)}
                  ref={fileInput}
                  tabIndex={-1}
                  type="file"
                />
                <button
                  className="btn-quiet"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                  type="button"
                >
                  {file ? "Choose another file" : "Choose .p12 or .pfx file"}
                </button>
                {file ? (
                  <span className="text-sm text-(--fg)">{file.name}</span>
                ) : null}
              </div>
              {errors.file ? (
                <p className="text-xs font-semibold text-(--danger)">
                  {errors.file}
                </p>
              ) : null}
              {file ? (
                <FieldShell
                  autoComplete="off"
                  disabled={busy}
                  helper="The file's password. Kept encrypted with the file."
                  ignorePasswordManagers
                  label="Password"
                  name="seal-p12-password"
                  onChange={(event) => setPassword(event.target.value)}
                  readOnly={false}
                  type="password"
                  value={password}
                />
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <ShellButton
          className="w-fit"
          disabled={busy}
          loading={pending === "save"}
          onClick={() => void save()}
        >
          {pending === "save" ? "Saving..." : "Save seal settings"}
        </ShellButton>

        {notice ? (
          <p
            className={`notice notice-${notice.tone}`}
            role={notice.tone === "danger" ? "alert" : "status"}
          >
            {notice.message}
          </p>
        ) : null}

        <div className="space-y-4 border-t border-(--border) pt-6">
          <h3 className="text-base font-extrabold text-(--fg)">
            The certificate sealing now
          </h3>
          {view.certificate.active ? (
            <CertificateDetails certificate={view.certificate.active} />
          ) : (
            <p className="text-sm text-(--secondary)">
              It could not be read just now.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <a
              className="btn-quiet"
              download
              href="/api/admin/seal/certificate?format=cer"
            >
              Download certificate (.cer)
            </a>
            <a
              className="btn-quiet"
              download
              href="/api/admin/seal/certificate?format=pem"
            >
              Download certificate (.pem)
            </a>
          </div>
          <div className="max-w-2xl space-y-2 text-sm leading-6 text-(--secondary)">
            <p>
              So that Adobe Acrobat on your organization&apos;s computers shows
              the seal as trusted, give them this certificate:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Push the .cer file to the computers&apos; trusted root
                certificates with your device management (Intune, Jamf, Google
                endpoint management or a group policy). In Acrobat, turn on
                Preferences, Signatures, Verification, &quot;Use Windows
                Certificate Store&quot; or the macOS keychain equivalent, for
                signatures and certified documents.
              </li>
              <li>
                Or, on one computer, open Acrobat&apos;s Preferences,
                Signatures, Identities &amp; Trusted Certificates, import the
                file and tick &quot;Use this certificate as a trusted root&quot;
                for signed documents.
              </li>
            </ul>
            <p>
              The certificate holds no secret. Readers outside your organization
              still see an unknown signer for the install&apos;s own
              certificate; a certificate from an authority they trust avoids
              that.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
