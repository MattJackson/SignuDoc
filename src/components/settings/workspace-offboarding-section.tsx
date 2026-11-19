"use client";

import { useEffect, useState } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { WorkspaceAdminView } from "@/lib/workspace/admin-view";
import type { OffboardingLastRun } from "@/lib/workspace/offboarding";
import type { WorkspaceSettingKey } from "@/lib/workspace/settings";

// Offboarding, in the workspace part of Settings: turn it on, say which
// domains are the organization's, see what the last run did, and run it
// now. The scheduled job and what it does are in
// src/lib/workspace/offboarding.ts.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type RunResponse = {
  error?: string;
  lastRun?: OffboardingLastRun | null;
} | null;

function describeRun(run: OffboardingLastRun): string {
  const when = new Date(run.ranAt * 1000).toLocaleString();

  if (run.stoppedEarly) {
    return `Last run ${when}: stopped, as most directory lookups failed. Nothing was changed.`;
  }

  const { blocked, checked, envelopesHandedOver, unblocked } = run.counts;

  return [
    `Last run ${when}: ${String(checked)} checked, ${String(blocked)} blocked, ${String(envelopesHandedOver)} envelopes handed over`,
    unblocked > 0 ? `, ${String(unblocked)} allowed back in` : "",
    run.moreToCheck ? ". More are checked on the next run." : ".",
  ].join("");
}

export function OffboardingSection({
  disabled,
  error,
  onChange,
  providerSaved,
  values,
  view,
}: {
  disabled: boolean;
  error?: string;
  onChange: (key: WorkspaceSettingKey, value: string) => void;
  providerSaved: boolean;
  values: Record<WorkspaceSettingKey, string>;
  view: WorkspaceAdminView;
}) {
  const enabled = view.settings["directory.offboarding"];
  const domains = view.settings["directory.domains"];
  const [lastRun, setLastRun] = useState<OffboardingLastRun | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/workspace/offboarding", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as RunResponse;

        setLastRun(payload?.lastRun ?? null);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  async function runNow() {
    setIsRunning(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/workspace/offboarding", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as RunResponse;

      if (!response.ok || !payload?.lastRun) {
        setMessage(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setLastRun(payload.lastRun);
    } catch {
      setMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-(--border) pt-8">
      <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        Offboarding
      </h3>
      <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
        When someone is suspended, archived or deleted in the directory, they
        can no longer sign in here, with a password or single sign-on, and their
        drafts and envelopes out for signature go to their manager, or to an
        administrator when there is none. The last administrator is never
        blocked. It runs once a day, and each change is in the site audit trail.
        It needs the directory to be on.
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5">
        <input
          checked={values["directory.offboarding"] === "on"}
          className="mt-1 size-4 accent-(--accent)"
          disabled={disabled || enabled.source === "env"}
          onChange={(event) =>
            onChange("directory.offboarding", event.target.checked ? "on" : "")
          }
          type="checkbox"
        />
        <span className="space-y-1">
          <span className="block text-sm font-bold text-(--fg)">
            Block people who leave the directory and hand over their work
          </span>
          {enabled.source === "env" ? (
            <span className="block text-xs leading-5 text-(--tertiary)">
              Set by {enabled.env} on the server.
            </span>
          ) : null}
        </span>
      </label>
      <div className="max-w-xl">
        <FieldShell
          disabled={disabled || domains.source === "env"}
          error={error}
          helper={
            domains.source === "env"
              ? `Set by ${domains.env} on the server.`
              : "Only accounts in these domains are checked. Empty: the sign-up rule's domains."
          }
          label="Organization domains"
          name="workspace-directory-domains"
          onChange={(event) =>
            onChange("directory.domains", event.target.value)
          }
          placeholder="yourcompany.com"
          readOnly={domains.source === "env"}
          value={values["directory.domains"]}
        />
      </div>
      <p
        className="max-w-2xl text-sm leading-6 text-(--secondary)"
        data-testid="workspace-offboarding-last-run"
      >
        {lastRun ? describeRun(lastRun) : "It has not run yet."}
      </p>
      <ShellButton
        className="w-fit"
        disabled={!providerSaved || enabled.value !== "on"}
        loading={isRunning}
        onClick={() => void runNow()}
        variant="secondary"
      >
        {isRunning ? "Running..." : "Run now"}
      </ShellButton>
      {message ? (
        <p className="notice notice-danger" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
