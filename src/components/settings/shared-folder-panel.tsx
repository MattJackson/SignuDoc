"use client";

import { useState, type ChangeEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import {
  exportsView,
  readExports,
} from "@/components/settings/workspace-exports";
import type { WorkspaceFilesSettingsView } from "@/lib/workspace/export-settings";
import type { WorkspaceExportListItem } from "@/lib/workspace/exports";
import type { WorkspaceCheck } from "@/lib/workspace/types";

// Settings, for the administrator: where copies of completed envelopes go
// in the workspace (a Shared Drive for Google), in which folders, the
// provider's own options (for Google, the Picker that starts envelopes
// from Drive, and a label on the copies), a check of it all, and the
// copies that failed, with a way to try one again.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const API = "/api/admin/workspace/files";

type Form = {
  destination: string;
  driveLabelId: string;
  folderPattern: string;
  /** Label field id and the value that goes in it, one row each. */
  labelRows: Array<{ fieldId: string; source: string }>;
  pickerApiKey: string;
  pickerAppId: string;
};

type Feedback = { message: string; tone: "error" | "success" } | null;

function formFrom(view: WorkspaceFilesSettingsView): Form {
  const rows = Object.entries(view.google?.driveLabelFields.mapping ?? {}).map(
    ([fieldId, source]) => ({ fieldId, source: source ?? "" }),
  );

  return {
    destination: view.destination.value ?? "",
    driveLabelId: view.google?.driveLabelId.value ?? "",
    folderPattern: view.folderPattern.value ?? view.folderPattern.defaultValue,
    labelRows: rows.length > 0 ? rows : [{ fieldId: "", source: "" }],
    pickerApiKey: view.google?.pickerApiKey.value ?? "",
    pickerAppId: view.google?.pickerAppId.value ?? "",
  };
}

const FIXED_HELPER =
  "Set by an environment variable, so it cannot be changed here.";

function describeStatus(item: WorkspaceExportListItem): string {
  switch (item.status) {
    case "exported":
      return item.metadataProblem
        ? `Copied; the label was not complete: ${item.metadataProblem}`
        : "Copied";
    case "pending":
      return item.lastError
        ? `Will try again (${String(item.attempts)} tries): ${item.lastError}`
        : "Waiting to be copied";
    case "failed":
      return `Gave up after ${String(item.attempts)} tries: ${item.lastError ?? "unknown error"}`;
  }
}

export function SharedFolderPanel({
  initialView,
}: {
  initialView: WorkspaceFilesSettingsView;
}) {
  const [view, setView] = useState(initialView);
  const [form, setForm] = useState(() => formFrom(initialView));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<WorkspaceCheck[] | null>(null);
  const [exportsList, setExportsList] = useState<
    WorkspaceExportListItem[] | null
  >(initialView.exports);
  const [exportsFailed, setExportsFailed] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const google = view.google;

  function update(field: keyof Omit<Form, "labelRows">) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;

      setFeedback(null);
      setForm((current) => ({ ...current, [field]: value }));
    };
  }

  function updateRow(index: number, change: Partial<Form["labelRows"][0]>) {
    setFeedback(null);
    setForm((current) => ({
      ...current,
      labelRows: current.labelRows.map((row, at) =>
        at === index ? { ...row, ...change } : row,
      ),
    }));
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    setErrors({});

    const driveLabelFields: Record<string, string> = {};

    for (const row of form.labelRows) {
      if (row.fieldId.trim() || row.source) {
        driveLabelFields[row.fieldId.trim()] = row.source;
      }
    }

    try {
      const response = await fetch(API, {
        body: JSON.stringify({
          destination: form.destination,
          folderPattern: form.folderPattern,
          ...(google
            ? {
                driveLabelFields,
                driveLabelId: form.driveLabelId,
                pickerApiKey: form.pickerApiKey,
                pickerAppId: form.pickerAppId,
              }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        view?: WorkspaceFilesSettingsView;
      } | null;

      if (!response.ok || !payload?.view) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setView(payload.view);
      setForm(formFrom(payload.view));
      setFeedback({ message: "Saved.", tone: "success" });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function post<T>(body: object): Promise<T | null> {
    const response = await fetch(API, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    return response.ok
      ? ((await response.json().catch(() => null)) as T)
      : null;
  }

  async function runCheck() {
    setChecking(true);

    try {
      const payload = await post<{ checks?: WorkspaceCheck[] }>({
        action: "check",
      });

      setChecks(payload?.checks ?? []);

      if (!payload) {
        setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
      }
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setChecking(false);
    }
  }

  async function refreshExports() {
    try {
      const list = readExports(
        await post<{ exports?: WorkspaceExportListItem[] }>({
          action: "list_exports",
        }),
      );

      setExportsFailed(list === null);

      if (list) {
        setExportsList(list);
      }
    } catch {
      setExportsFailed(true);
    }
  }

  async function retry(envelopeId: string) {
    setRetrying(envelopeId);

    try {
      const payload = await post<{
        result?: { message?: string; ok: boolean };
      }>({ action: "retry_export", envelopeId });

      if (!payload?.result?.ok) {
        setFeedback({
          message: payload?.result?.message ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
      }

      await refreshExports();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setRetrying(null);
    }
  }

  const listState = exportsView(exportsList, exportsFailed);

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="shared-folder"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Shared folder for completed envelopes
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Every completed envelope&apos;s signed PDF and certificate can be
            kept in {view.filesName}, in a shared place your organization owns.
            Copies are made right after completion and tried again if{" "}
            {view.providerName} is unavailable. Completion never waits for them.
          </p>
        </div>

        <div className="grid max-w-2xl gap-4">
          <FieldShell
            disabled={view.destination.source === "env" || saving}
            error={errors.destination}
            helper={
              view.destination.source === "env"
                ? FIXED_HELPER
                : google
                  ? "The Shared Drive's ID, or its address from the browser. Add the site's service account to it as a Content manager. Empty turns copies off."
                  : "Where copies go. Empty turns copies off."
            }
            label={google ? "Shared Drive" : "Shared location"}
            name="destination"
            onChange={update("destination")}
            readOnly={false}
            value={form.destination}
          />
          <FieldShell
            disabled={view.folderPattern.source === "env" || saving}
            error={errors.folderPattern}
            helper={
              view.folderPattern.source === "env"
                ? FIXED_HELPER
                : `Folders, then the file's name. Tokens: {yyyy} {MM} {dd} {yyyy-MM} {yyyy-MM-dd} {title} {shortId} {envelopeId} {senderEmail}. An envelope completed now goes to: ${view.folderPattern.preview}`
            }
            label="Folders and file name"
            name="folderPattern"
            onChange={update("folderPattern")}
            readOnly={false}
            value={form.folderPattern}
          />
        </div>

        {google ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-base font-extrabold text-(--fg)">
                Start envelopes from Google Drive
              </h3>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                People connect their own Drive and pick a file in the Google
                Picker. Add{" "}
                <code className="text-(--fg)">
                  {view.callbackUri ?? "/api/workspace/files/callback"}
                </code>{" "}
                as a redirect URI of the OAuth client.
              </p>
            </div>
            <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <FieldShell
                disabled={google.pickerApiKey.source === "env" || saving}
                error={errors.pickerApiKey}
                helper={
                  google.pickerApiKey.source === "env"
                    ? FIXED_HELPER
                    : "A browser key, restricted to this site and the Picker API."
                }
                ignorePasswordManagers
                label="Google Picker API key"
                name="pickerApiKey"
                onChange={update("pickerApiKey")}
                readOnly={false}
                value={form.pickerApiKey}
              />
              <FieldShell
                disabled={google.pickerAppId.source === "env" || saving}
                error={errors.pickerAppId}
                helper={
                  google.pickerAppId.source === "env"
                    ? FIXED_HELPER
                    : "The Cloud project's number."
                }
                label="Google Cloud project number"
                name="pickerAppId"
                onChange={update("pickerAppId")}
                readOnly={false}
                value={form.pickerAppId}
              />
            </div>

            <div className="space-y-1.5">
              <h3 className="text-base font-extrabold text-(--fg)">
                Drive label on the copies
              </h3>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Optional. A published label the service account may apply, and
                which value goes into each of its fields. Run the check to see
                the label&apos;s fields.
              </p>
            </div>
            <div className="grid max-w-2xl gap-4">
              <FieldShell
                disabled={google.driveLabelId.source === "env" || saving}
                error={errors.driveLabelId}
                helper={
                  google.driveLabelId.source === "env"
                    ? FIXED_HELPER
                    : undefined
                }
                label="Drive label ID"
                name="driveLabelId"
                onChange={update("driveLabelId")}
                readOnly={false}
                value={form.driveLabelId}
              />
              {form.labelRows.map((row, index) => (
                <div className="grid gap-3 sm:grid-cols-2" key={index}>
                  <label className="grid gap-1.5">
                    <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                      Field ID
                    </span>
                    <input
                      className="field-input"
                      disabled={google.driveLabelId.source === "env" || saving}
                      onChange={(event) =>
                        updateRow(index, { fieldId: event.target.value })
                      }
                      value={row.fieldId}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                      Value
                    </span>
                    <select
                      className="field-input"
                      disabled={google.driveLabelId.source === "env" || saving}
                      onChange={(event) =>
                        updateRow(index, { source: event.target.value })
                      }
                      value={row.source}
                    >
                      <option value="">Nothing</option>
                      {view.metadataKeys.map((key) => (
                        <option key={key.id} value={key.id}>
                          {key.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
              {errors.driveLabelFields ? (
                <p className="text-xs font-semibold text-(--danger)">
                  {errors.driveLabelFields}
                </p>
              ) : null}
              <button
                className="btn-quiet w-fit"
                disabled={google.driveLabelId.source === "env" || saving}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    labelRows: [
                      ...current.labelRows,
                      { fieldId: "", source: "" },
                    ],
                  }))
                }
                type="button"
              >
                Add a field
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <ShellButton loading={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save shared folder"}
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

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-extrabold text-(--fg)">
              Recent copies
            </h3>
            <button
              className="btn-quiet"
              onClick={() => void refreshExports()}
              type="button"
            >
              Refresh
            </button>
          </div>
          {listState === "failed" ? (
            <p className="notice notice-danger" role="alert">
              The copies could not be listed. Please try again.
            </p>
          ) : listState === "empty" ? (
            <p className="text-sm leading-6 text-(--secondary)">
              No completed envelope has been copied yet.
            </p>
          ) : listState === "list" ? (
            <ul className="divide-y divide-(--border) rounded-2xl bg-(--surface)">
              {(exportsList ?? []).map((item) => {
                const signed = item.files?.find(
                  (file) => file.kind === "signed",
                );

                return (
                  <li
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    key={item.envelopeId}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-bold text-(--fg)">
                        {signed?.url ? (
                          <a
                            className="underline underline-offset-4"
                            href={signed.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </p>
                      <p className="text-xs leading-5 text-(--secondary)">
                        {describeStatus(item)}
                      </p>
                    </div>
                    {item.status !== "pending" ? (
                      <button
                        className="btn-quiet"
                        disabled={retrying !== null}
                        onClick={() => void retry(item.envelopeId)}
                        type="button"
                      >
                        {retrying === item.envelopeId
                          ? "Trying..."
                          : "Try again"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
