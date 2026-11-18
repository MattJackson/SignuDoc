"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import {
  EnvLockedNotice,
  ExternalButton,
  IntegrationPanel,
  type ConnectionStatus,
} from "@/components/settings/integration-kit";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { describeRecordStatus } from "@/lib/email-record-status";
import type { EmailDnsRecord, EmailStatus } from "@/lib/email-status";

// Email setup, in Settings and in onboarding: the Resend API key (pasted
// here, or RESEND_API_KEY where the site runs, which wins), the sending
// domain and its DNS records, and a test email to prove it all works.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const RESEND_API_KEYS_URL = "https://resend.com/api-keys";
const RESEND_DOMAINS_URL = "https://resend.com/domains";
const RESEND_MARKETPLACE_URL = "https://vercel.com/marketplace/resend";

type Feedback = {
  message: string;
  tone: "error" | "success";
} | null;

type KeyState = { source: "env" | "settings" | null };

type EmailResponse = {
  access?: "full" | "sending" | null;
  error?: string;
  key?: KeyState;
  status?: EmailStatus;
  test?: { sent: true; to: string } | { sent: false; message: string };
} | null;

type EmailAction =
  "add_domain" | "recheck" | "remove_key" | "save_key" | "send_test";

/** The four stages an administrator goes through, for the badge. */
function describeStage(status: EmailStatus): {
  label: string;
  tone: "accent" | "neutral" | "success" | "warning";
} {
  switch (status.state) {
    case "capture":
      return { label: "Captured locally", tone: "neutral" };
    case "missing_key":
      return { label: "Not configured", tone: "warning" };
    case "ready":
      return { label: "Verified", tone: "success" };
    case "domain_pending":
      return { label: "Domain pending", tone: "accent" };
    case "error":
      return { label: "Could not check", tone: "warning" };
    default:
      return { label: "Key OK", tone: "accent" };
  }
}

/** Settings, Integrations, Email. */
export function EmailPanel({
  detail,
  status,
}: {
  detail: string;
  status: ConnectionStatus;
}) {
  const router = useRouter();

  return (
    <IntegrationPanel
      brand="resend"
      description="Signing invitations, reminders and finished documents are emailed through Resend, from an address at your own domain. The sender and support addresses are under Organization."
      detail={detail}
      id="email"
      name="Email"
      status={status}
    >
      {/* The header's status is worked out on the server. */}
      <EmailSetupPanel onStatusChange={() => router.refresh()} />
    </IntegrationPanel>
  );
}

/** Email's steps, in Settings and in onboarding. */
export function EmailSetupPanel({
  onStatusChange,
}: {
  /** Told when the status changes, so onboarding can move on. */
  onStatusChange?: (status: EmailStatus) => void;
} = {}) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<EmailAction | null>(null);
  const [result, setResult] = useState<Feedback>(null);
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);

  function apply(payload: EmailResponse) {
    if (payload?.status) {
      setLoadError(null);
      setStatus(payload.status);
      onStatusChange?.(payload.status);
    }

    if (payload?.key) {
      setKeyState(payload.key);
    }
  }

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/email", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as EmailResponse;

        if (!response.ok || !payload?.status) {
          setLoadError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        apply(payload);
      })
      .catch((error: unknown) => {
        // Leaving the page cancels the request; that is not a failure.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
    // Loaded once; actions below report the new status themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(action: EmailAction, extra: object = {}) {
    if (pendingAction) {
      return;
    }

    setPendingAction(action);
    setResult(null);

    try {
      const response = await fetch("/api/admin/email", {
        body: JSON.stringify({ action, ...extra }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as EmailResponse;

      apply(payload);

      if (payload?.test) {
        setResult(
          payload.test.sent
            ? {
                message: `Test email sent to ${payload.test.to}. Check that inbox.`,
                tone: "success",
              }
            : { message: payload.test.message, tone: "error" },
        );
      } else if (!response.ok) {
        setResult({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
      } else if (action === "save_key") {
        setApiKey("");
        setReplacingKey(false);
        setResult({
          message:
            payload?.access === "sending"
              ? "Key saved. It may only send, so add your domain in Resend; this page cannot list its DNS records."
              : "Key saved and checked with Resend.",
          tone: "success",
        });
      } else if (action === "remove_key") {
        setResult({ message: "The saved key was removed.", tone: "success" });
      }
    } catch {
      setResult({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPendingAction(null);
    }
  }

  function handleKeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (apiKey.trim()) {
      void runAction("save_key", { apiKey: apiKey.trim() });
    }
  }

  const summary = status ? describeEmailStatus(status) : null;
  const stage = status ? describeStage(status) : null;
  const canSendTest =
    status !== null &&
    status.state !== "missing_key" &&
    status.state !== "capture";
  const showKeyForm =
    keyState !== null &&
    keyState.source !== "env" &&
    status?.state !== "capture" &&
    (keyState.source === null || replacingKey);

  return (
    <div className="space-y-5" id="email-setup">
      {stage ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-(--secondary)">
          Resend:
          <span className={`pill pill-${stage.tone}`} data-email-stage>
            {stage.label}
          </span>
        </p>
      ) : null}

      {loadError ? (
        <p className="notice notice-danger" role="alert">
          {loadError}
        </p>
      ) : null}

      {!summary ? (
        loadError ? null : (
          <p className="text-sm text-(--secondary)">Checking email…</p>
        )
      ) : (
        <div
          className={`space-y-2 rounded-2xl px-5 py-4 ${
            summary.ready ? "bg-(--success-soft)" : "bg-(--surface)"
          }`}
          data-email-state={status?.state}
        >
          <p className="text-sm font-bold text-(--fg)">{summary.title}</p>
          {summary.lines.map((line) => (
            <p className="text-sm leading-6 text-(--secondary)" key={line}>
              {line}
            </p>
          ))}
          {summary.steps ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary) marker:font-semibold marker:text-(--fg)">
              {summary.steps.map((step) => (
                <li key={step.text}>
                  {step.text}
                  {step.link ? (
                    <>
                      {" "}
                      <a
                        className="font-semibold text-(--accent-ink) underline underline-offset-4"
                        href={step.link.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {step.link.label}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}

      {keyState?.source === "env" ? (
        <EnvLockedNotice variables={["RESEND_API_KEY"]} />
      ) : null}

      {keyState?.source === "settings" && !replacingKey ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="text-sm leading-6 text-(--secondary)">
            A Resend API key is saved in this app, encrypted. It is not shown
            again.
          </p>
          <div className="flex gap-2">
            <ShellButton
              disabled={pendingAction !== null}
              onClick={() => setReplacingKey(true)}
              variant="ghost"
            >
              Replace key
            </ShellButton>
            <ShellButton
              disabled={pendingAction !== null}
              loading={pendingAction === "remove_key"}
              onClick={() => void runAction("remove_key")}
              variant="ghost"
            >
              Remove key
            </ShellButton>
          </div>
        </div>
      ) : null}

      {showKeyForm ? (
        <form
          className="space-y-4 rounded-2xl border border-(--border) p-5"
          noValidate
          onSubmit={handleKeySubmit}
        >
          <div className="space-y-2">
            <p className="text-sm font-bold text-(--fg)">
              {replacingKey ? "Replace the Resend API key" : "Connect Resend"}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-(--secondary)">
              <li>
                Sign in to Resend and open{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline underline-offset-4"
                  href={RESEND_API_KEYS_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  API keys
                </a>
                .
              </li>
              <li>
                Create a key with Full access, so this page can add your domain
                and show its DNS records. A sending-only key works too, but then
                the domain is set up in Resend itself.
              </li>
              <li>
                Paste it here. It is checked with Resend, then stored encrypted.
              </li>
            </ol>
          </div>
          <div className="max-w-xl">
            <FieldShell
              autoComplete="off"
              disabled={pendingAction !== null}
              ignorePasswordManagers
              label="Resend API key"
              name="resend-api-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="re_..."
              readOnly={false}
              type="password"
              value={apiKey}
            />
          </div>
          <div className="flex gap-2">
            <ShellButton
              disabled={pendingAction !== null || apiKey.trim().length === 0}
              loading={pendingAction === "save_key"}
              type="submit"
            >
              {pendingAction === "save_key" ? "Checking..." : "Save key"}
            </ShellButton>
            {replacingKey ? (
              <ShellButton
                disabled={pendingAction !== null}
                onClick={() => {
                  setReplacingKey(false);
                  setApiKey("");
                }}
                variant="ghost"
              >
                Cancel
              </ShellButton>
            ) : null}
          </div>
        </form>
      ) : null}

      {status?.state === "domain_pending" ? (
        <DnsRecordsTable domain={status.domain} records={status.records} />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {status?.state === "domain_missing" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "add_domain"}
            onClick={() => void runAction("add_domain")}
          >
            {pendingAction === "add_domain"
              ? "Adding..."
              : `Set up ${status.domain}`}
          </ShellButton>
        ) : null}
        {status?.state === "domain_pending" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "recheck"}
            onClick={() => void runAction("recheck")}
          >
            {pendingAction === "recheck" ? "Checking..." : "Check DNS records"}
          </ShellButton>
        ) : null}
        {canSendTest ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "send_test"}
            onClick={() => void runAction("send_test")}
            variant="secondary"
          >
            {pendingAction === "send_test"
              ? "Sending..."
              : "Send me a test email"}
          </ShellButton>
        ) : null}
        {status?.state === "restricted_key" ||
        status?.state === "error" ||
        status?.state === "test_sender" ? (
          <ExternalButton href={RESEND_DOMAINS_URL}>Open Resend</ExternalButton>
        ) : null}
      </div>

      {result ? (
        <p
          className={`notice ${
            result.tone === "success" ? "notice-success" : "notice-danger"
          }`}
          role={result.tone === "error" ? "alert" : "status"}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

type EmailStep = {
  link?: { href: string; label: string };
  text: string;
};

function describeEmailStatus(status: EmailStatus): {
  lines: string[];
  ready: boolean;
  steps?: EmailStep[];
  title: string;
} {
  switch (status.state) {
    case "capture":
      return {
        lines: [
          "This is a development setup. Emails are saved to a folder on this machine instead of being sent.",
        ],
        ready: true,
        title: "Emails are being captured, not sent",
      };
    case "missing_key":
      return status.onVercel
        ? {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
              "Paste a Resend API key below, or connect Resend to this Vercel project instead:",
            ],
            ready: false,
            steps: [
              {
                link: {
                  href: RESEND_MARKETPLACE_URL,
                  label: "Resend on the Vercel Marketplace",
                },
                text: "Open Resend on the Vercel Marketplace. Choose Install (or Connect Project if your team already has Resend) and connect it to this project.",
              },
              {
                text: "In this project on Vercel, open Settings, then Environment Variables, and check that RESEND_API_KEY is listed for Production.",
              },
              {
                text: "Open Deployments, open the ••• menu on the latest Production deployment and choose Redeploy. Environment variables only reach deployments made after they were added, so a site deployed before Resend was connected still has no key until it is redeployed.",
              },
            ],
            title: "Email is not connected",
          }
        : {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
              "Paste a Resend API key below. Setting RESEND_API_KEY where this site runs works too, and wins over a key saved here.",
            ],
            ready: false,
            title: "Email is not connected",
          };
    case "test_sender":
      return {
        lines: [
          `Emails are going out from Resend's shared test address (${status.senderAddress}). Resend only delivers those to the owner of the Resend account, so signers and new users will not receive anything yet.`,
          'Enter an address at your own domain in "Send email from" and save. The DNS records to add will appear here.',
        ],
        ready: false,
        title: "Email only reaches you so far",
      };
    case "domain_missing":
      return {
        lines: [
          `${status.domain} has not been added to your Resend account yet. Set it up here to get the DNS records that prove you own it.`,
        ],
        ready: false,
        title: `${status.domain} needs to be set up`,
      };
    case "domain_pending":
      return {
        lines: [
          `Add these records where ${status.domain}'s DNS is managed, then check them. DNS changes can take a few minutes to be seen, and sometimes longer.`,
          ...(status.mayAlreadySend
            ? [
                "Resend has verified part of this domain, so sending may already work. Send yourself a test email to find out. If it arrives, email is working.",
              ]
            : []),
        ],
        ready: false,
        title: `Waiting for ${status.domain}'s DNS records`,
      };
    case "restricted_key":
      return {
        lines: [
          `This site's Resend key is only allowed to send email, so it cannot check ${status.domain} from here. Open Resend to add the domain and see its DNS records.`,
          "When that is done, send yourself a test email. If it arrives, email is working.",
        ],
        ready: false,
        title: "Finish the domain in Resend",
      };
    case "ready":
      return {
        lines: [
          `Emails are sent from ${status.senderAddress}, and ${status.domain} is verified.`,
        ],
        ready: true,
        title: "Email is working",
      };
    case "error":
      return {
        lines: [
          `Resend could not be asked about this site's email: ${status.message}`,
        ],
        ready: false,
        title: "Email could not be checked",
      };
  }
}

function DnsRecordsTable({
  domain,
  records,
}: {
  domain: string;
  records: readonly EmailDnsRecord[];
}) {
  if (records.length === 0) {
    return (
      <p className="text-sm leading-6 text-(--secondary)">
        Resend did not list any records for {domain}. Open Resend to see them.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-(--border)">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">DNS records to add for {domain}</caption>
        <thead>
          <tr className="border-b border-(--border) bg-(--surface) text-xs text-(--tertiary)">
            <th className="px-4 py-3 font-semibold" scope="col">
              Type
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Name
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Value
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              className="border-b border-(--border) align-top last:border-b-0"
              key={`${record.type}-${record.name}-${record.value}`}
            >
              <td className="px-4 py-3 font-semibold text-(--fg)">
                {record.type}
                {record.priority !== null ? (
                  <span className="block text-xs font-normal text-(--tertiary)">
                    Priority {record.priority}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.name}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.value}
              </td>
              <td className="px-4 py-3 text-(--secondary)">
                {describeRecordStatus(record.status)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
