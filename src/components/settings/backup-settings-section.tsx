"use client";

import { useState } from "react";

import { EnvLockedNotice } from "@/components/settings/integration-kit";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type {
  BackupRun,
  BackupRunOutcome,
  BackupSettingsView,
  BackupTestResult,
} from "@/lib/backup-config";

// The Backups section of Settings, for the administrator: where the daily
// backup goes (a Google Cloud Storage bucket or a second Vercel Blob store),
// how long copies are kept, a test of the destination, "Run backup now",
// and the last runs. What the deployment sets in the environment is shown
// and cannot be changed here. Self-contained, so first-run setup can show
// it as one of its steps.

type Kind = "blob" | "gcs" | "none";

type FormValues = {
  bucket: string;
  enabled: boolean;
  keepDays: string;
  kind: Kind;
  prefix: string;
  token: string;
};

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

function toFormValues(view: BackupSettingsView): FormValues {
  const destination = view.destination;

  return {
    bucket: destination.kind === "gcs" ? destination.bucket : "",
    enabled: view.enabled,
    keepDays: String(view.keepDays),
    kind: destination.kind,
    prefix: destination.kind === "gcs" ? destination.prefix : "",
    token: "",
  };
}

function toDestination(values: FormValues) {
  switch (values.kind) {
    case "gcs":
      return { bucket: values.bucket, kind: "gcs", prefix: values.prefix };
    case "blob":
      return { kind: "blob", token: values.token };
    default:
      return { kind: "none" };
  }
}

function formatTime(seconds: number | null): string {
  return seconds
    ? new Date(seconds * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
}

function describeRun(run: BackupRun): string {
  const summary = run.summary;
  const counts = summary
    ? `${String(summary.filesCopied ?? 0)} files copied, ${String(summary.filesUnchanged ?? 0)} unchanged`
    : "";

  switch (run.status) {
    case "running":
      return "Running";
    case "succeeded":
      return summary?.stoppedEarly
        ? `Done for now (${counts}); the next run carries on`
        : `Succeeded (${counts})`;
    case "partial":
      return `Partly done: ${run.error ?? ""}`;
    case "failed":
      return `Failed: ${run.error ?? "unknown reason"}`;
  }
}

function describeOutcome(outcome: BackupRunOutcome): {
  message: string;
  tone: "danger" | "success" | "warning";
} {
  switch (outcome.status) {
    case "finished":
      return outcome.summary.fileFailures.length > 0
        ? {
            message: `The backup finished, but ${String(outcome.summary.fileFailures.length)} files could not be copied.`,
            tone: "warning",
          }
        : {
            message: outcome.summary.stoppedEarly
              ? "The backup ran out of time and will carry on with the next run."
              : "The backup finished.",
            tone: "success",
          };
    case "busy":
      return { message: "A backup is already running.", tone: "warning" };
    case "not_configured":
      return { message: "Choose where backups go first.", tone: "warning" };
    case "disabled":
      return { message: "The daily backup is turned off.", tone: "warning" };
    case "failed":
    case "misconfigured":
      return { message: outcome.message, tone: "danger" };
  }
}

export function BackupSettingsSection({
  initialView,
  onChange,
}: {
  initialView: BackupSettingsView;
  /** Called after a save or a run, so onboarding can read its checklist again. */
  onChange?: () => void;
}) {
  const [view, setView] = useState(initialView);
  const [values, setValues] = useState(() => toFormValues(initialView));
  const [pending, setPending] = useState<"run" | "save" | "test" | null>(null);
  const [notice, setNotice] = useState<{
    hint?: string | null;
    message: string;
    tone: "danger" | "success" | "warning";
  } | null>(null);
  const locked = view.locked;
  const busy = pending !== null;
  const suggested = view.primaryDriver === "blob" ? "blob" : "gcs";

  async function call(method: "POST" | "PUT", body: unknown) {
    const response = await fetch("/api/admin/backup", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method,
    });
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!response.ok) {
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : GENERIC_ERROR_MESSAGE,
      );
    }

    return payload;
  }

  async function save() {
    setPending("save");
    setNotice(null);

    try {
      const next = (await call("PUT", {
        destination: toDestination(values),
        enabled: values.enabled,
        keepDays: values.keepDays,
      })) as BackupSettingsView;

      setView(next);
      setValues(toFormValues(next));
      setNotice({ message: "Backup settings saved.", tone: "success" });
      onChange?.();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE,
        tone: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  async function test() {
    setPending("test");
    setNotice(null);

    try {
      // An unchanged Blob form has no token to send: the saved one is tried.
      const result = (await call("POST", {
        action: "test",
        destination: locked.destination ? undefined : toDestination(values),
      })) as BackupTestResult;

      setNotice(
        result.ok
          ? {
              message:
                "The destination works: a test file was written, listed, read back and deleted.",
              tone: "success",
            }
          : {
              hint: result.hint,
              message: `The test stopped at the ${result.step} step. ${result.message}`,
              tone: "danger",
            },
      );
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE,
        tone: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  async function runNow() {
    setPending("run");
    setNotice(null);

    try {
      const result = (await call("POST", { action: "run" })) as {
        outcome: BackupRunOutcome;
        view: BackupSettingsView;
      };

      setView(result.view);
      setNotice(describeOutcome(result.outcome));
      onChange?.();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE,
        tone: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  const kindOptions: Array<{
    description: string;
    label: string;
    value: Kind;
  }> = [
    {
      description:
        "A bucket of its own, ideally in another Google Cloud project. On Google Cloud no key is needed: the app writes as its service account.",
      label: "Google Cloud Storage bucket",
      value: "gcs",
    },
    {
      description:
        "A second, private Blob store, ideally in another Vercel team, by its read-write token.",
      label: "Vercel Blob store",
      value: "blob",
    },
    { description: "No backups.", label: "Off", value: "none" },
  ];
  const orderedOptions = [
    ...kindOptions.filter((option) => option.value === suggested),
    ...kindOptions.filter((option) => option.value !== suggested),
  ];
  const statusTone =
    view.status.state === "done"
      ? "notice-success"
      : view.status.state === "failing"
        ? "notice-danger"
        : "notice-warning";

  // In onboarding (which passes onChange) the step around it has the
  // title and the card.
  const embedded = onChange !== undefined;

  return (
    <section
      className={embedded ? undefined : "panel scroll-mt-6 p-6 sm:p-8"}
      data-animate={embedded ? undefined : "enter"}
      data-animate-delay="2"
      data-testid="backup-settings"
      id="backups"
    >
      <div className="space-y-6">
        {embedded ? null : (
          <div className="space-y-2">
            <p className="section-eyebrow">Administrator</p>
            <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
              Backups
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
              Once a day the database and every stored document are copied to a
              place kept apart from this install. Copies of deleted documents
              and old database copies are removed after the number of days
              below. The database&apos;s own backups (Cloud SQL or Neon) are
              separate; keep those on too.
            </p>
          </div>
        )}

        <p className={`notice ${statusTone}`} role="status">
          {view.status.message}
        </p>

        <fieldset className="space-y-3" disabled={busy || locked.destination}>
          <legend className="pb-2 text-sm font-bold text-(--fg)">
            Where backups go
          </legend>
          {locked.destination ? (
            <EnvLockedNotice
              variables={["BACKUP_GCS_BUCKET", "BACKUP_BLOB_READ_WRITE_TOKEN"]}
            />
          ) : null}
          {orderedOptions.map((option) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
              key={option.value}
            >
              <input
                checked={values.kind === option.value}
                className="mt-1 size-4 accent-(--accent)"
                name="backup-destination"
                onChange={() =>
                  setValues((current) => ({ ...current, kind: option.value }))
                }
                type="radio"
                value={option.value}
              />
              <span className="space-y-1">
                <span className="block text-sm font-bold text-(--fg)">
                  {option.label}
                  {option.value === suggested ? " (suggested)" : ""}
                </span>
                <span className="block text-sm leading-6 text-(--secondary)">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {values.kind === "gcs" ? (
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={busy || locked.destination}
              label="Bucket"
              name="backup-bucket"
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  bucket: event.target.value,
                }))
              }
              placeholder="my-signudoc-backups"
              readOnly={false}
              value={values.bucket}
            />
            <FieldShell
              disabled={busy || locked.destination}
              helper="Optional."
              label="Folder in the bucket"
              name="backup-prefix"
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  prefix: event.target.value,
                }))
              }
              placeholder="signudoc"
              readOnly={false}
              value={values.prefix}
            />
            <p className="text-sm leading-6 text-(--secondary) sm:col-span-2">
              Grant <code>roles/storage.objectAdmin</code> on the bucket to{" "}
              {view.serviceAccountEmail ? (
                <code className="break-all text-(--fg)">
                  {view.serviceAccountEmail}
                </code>
              ) : (
                "the service account the app runs as"
              )}
              , and turn on object versioning for the bucket.
            </p>
          </div>
        ) : null}

        {values.kind === "blob" && !locked.destination ? (
          <div className="max-w-xl">
            <FieldShell
              disabled={busy}
              helper={
                view.destination.kind === "blob" && view.destination.hasToken
                  ? "A token is saved. Leave this empty to keep it."
                  : "Starts with vercel_blob_rw_. Kept encrypted."
              }
              ignorePasswordManagers
              label="Read-write token of the backup store"
              name="backup-blob-token"
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  token: event.target.value,
                }))
              }
              readOnly={false}
              type="password"
              value={values.token}
            />
          </div>
        ) : null}

        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <FieldShell
            disabled={busy || locked.keepDays}
            helper={
              locked.keepDays
                ? "Set by the deployment (BACKUP_KEEP_DAYS)."
                : "1 to 3650. The newest three database copies are always kept."
            }
            label="Days to keep copies"
            name="backup-keep-days"
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                keepDays: event.target.value,
              }))
            }
            readOnly={false}
            value={values.keepDays}
          />
          <label className="flex items-center gap-3 self-end pb-2 text-sm font-semibold text-(--fg)">
            <input
              checked={values.enabled}
              className="size-4 accent-(--accent)"
              disabled={busy || locked.destination}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
              type="checkbox"
            />
            Run the daily backup
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <ShellButton
            disabled={busy}
            loading={pending === "save"}
            onClick={save}
          >
            {pending === "save" ? "Saving..." : "Save backup settings"}
          </ShellButton>
          <ShellButton
            disabled={busy || values.kind === "none"}
            loading={pending === "test"}
            onClick={test}
            variant="secondary"
          >
            {pending === "test" ? "Testing..." : "Test destination"}
          </ShellButton>
          <ShellButton
            disabled={busy || view.destination.kind === "none"}
            loading={pending === "run"}
            onClick={runNow}
            variant="secondary"
          >
            {pending === "run" ? "Backing up..." : "Run backup now"}
          </ShellButton>
        </div>

        {notice ? (
          <div
            className={`notice notice-${notice.tone} space-y-2`}
            role={notice.tone === "danger" ? "alert" : "status"}
          >
            <p>{notice.message}</p>
            {notice.hint ? (
              <p className="break-all font-mono text-xs">{notice.hint}</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3 border-t border-(--border) pt-6">
          <h3 className="text-base font-extrabold text-(--fg)">Last runs</h3>
          {view.runs.length === 0 ? (
            <p className="text-sm text-(--secondary)">No backup has run yet.</p>
          ) : (
            <ul className="space-y-2 text-sm leading-6 text-(--secondary)">
              {view.runs.map((run) => (
                <li key={run.id}>
                  <span className="font-semibold text-(--fg)">
                    {formatTime(run.startedAt)}
                  </span>{" "}
                  ({run.trigger === "manual" ? "by hand" : "daily"},{" "}
                  {run.destination}): {describeRun(run)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
