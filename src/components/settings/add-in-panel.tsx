"use client";

import { useState } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { AddInSettingsView } from "@/lib/workspace/add-in";
import type { WorkspaceCheck } from "@/lib/workspace/types";

// Settings, for administrators: the workspace add-in (the Gmail and Drive
// add-on for Google Workspace). The deployment file and steps carry this
// site's own URLs; the values the provider gives back once it is deployed
// are saved here (through the workspace settings route) or set with the
// environment variables named, which win. The check says whether the
// add-in can answer.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const DOWNLOAD_URL = "/api/admin/workspace/add-in?download=1";

type Feedback = { message: string; tone: "error" | "success" } | null;

export function AddInPanel({ view: initialView }: { view: AddInSettingsView }) {
  const [view, setView] = useState(initialView);
  const deployment = view.deployment;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initialView.deployment?.values ?? []).map((item) => [
        item.setting,
        item.value ?? "",
      ]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<WorkspaceCheck[] | null>(null);

  async function save() {
    if (!deployment) {
      return;
    }

    setSaving(true);
    setFeedback(null);
    setErrors({});

    const settings: Record<string, string> = {};

    for (const item of deployment.values) {
      if (item.source !== "env") {
        settings[item.setting] = values[item.setting] ?? "";
      }
    }

    try {
      const response = await fetch("/api/admin/workspace", {
        body: JSON.stringify({ settings }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
      } | null;

      if (!response.ok) {
        setErrors(body?.fieldErrors ?? {});
        setFeedback({
          message: body?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      const refreshed = await fetch("/api/admin/workspace/add-in");
      const next = (await refreshed.json().catch(() => null)) as {
        view?: AddInSettingsView;
      } | null;

      if (next?.view) {
        setView(next.view);
      }

      setFeedback({ message: "Saved.", tone: "success" });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function runCheck() {
    setChecking(true);
    setFeedback(null);

    try {
      const response = await fetch("/api/admin/workspace/add-in", {
        body: JSON.stringify({ action: "check" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        checks?: WorkspaceCheck[];
        error?: string;
      } | null;

      if (response.ok && body?.checks) {
        setChecks(body.checks);
      } else {
        setFeedback({
          message: body?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
      }
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setChecking(false);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      id="add-in"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Add-in for {view.provider}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            People send email attachments and files for signature from a side
            panel in their mail and files. It reads only the open message or the
            selected file, and makes a draft they finish here.
            {deployment?.ready
              ? " It is set up and answers requests."
              : " It answers nothing until the values below are set."}
          </p>
        </div>

        {!deployment ? (
          <p className="text-sm leading-6 text-(--secondary)">
            {view.provider} has no add-in.
          </p>
        ) : (
          <>
            {deployment.problem ? (
              <p className="notice notice-warning" role="status">
                {deployment.problem}
              </p>
            ) : null}

            <div className="space-y-3">
              <h3 className="text-base font-extrabold text-(--fg)">Deploy</h3>
              {deployment.file ? (
                <a className="btn-quiet w-fit" download href={DOWNLOAD_URL}>
                  Download {deployment.file.name}
                </a>
              ) : null}
              <ol className="max-w-2xl list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary)">
                {deployment.steps.map((step) => (
                  <li key={step.command ?? step.text}>
                    {step.text}
                    {step.command ? (
                      <code className="mt-1 block break-all text-(--fg)">
                        {step.command}
                      </code>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-3">
              <h3 className="text-base font-extrabold text-(--fg)">
                Values from {view.provider}
              </h3>
              <div className="grid max-w-2xl gap-4">
                {deployment.values.map((item) => (
                  <FieldShell
                    disabled={item.source === "env" || saving}
                    error={errors[item.setting]}
                    helper={
                      item.source === "env"
                        ? `Set by ${item.env} on the server.`
                        : `Or set ${item.env} on the server.`
                    }
                    key={item.setting}
                    label={item.label}
                    name={item.setting}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [item.setting]: event.target.value,
                      }))
                    }
                    readOnly={false}
                    value={values[item.setting] ?? ""}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <ShellButton loading={saving} onClick={() => void save()}>
                {saving ? "Saving..." : "Save add-in values"}
              </ShellButton>
              <ShellButton
                loading={checking}
                onClick={() => void runCheck()}
                variant="secondary"
              >
                {checking ? "Checking..." : "Check"}
              </ShellButton>
            </div>

            {feedback ? (
              <p
                className={`notice ${feedback.tone === "error" ? "notice-danger" : "notice-success"}`}
                role={feedback.tone === "error" ? "alert" : "status"}
              >
                {feedback.message}
              </p>
            ) : null}

            {checks ? (
              <ul className="space-y-2" role="status">
                {checks.map((check) => (
                  <li
                    className={`notice ${check.ok ? "notice-success" : "notice-warning"}`}
                    key={check.id}
                  >
                    <strong>{check.name}:</strong> {check.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
