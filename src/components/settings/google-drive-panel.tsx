"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  CheckItem,
  CopyValue,
  ExternalLink,
  IntegrationPanel,
  Notice as KitNotice,
  SetupSteps,
  type ConnectionStatus,
} from "@/components/settings/integration-kit";
import { exportsView, readExports } from "@/components/settings/drive-exports";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type {
  GoogleDriveView,
  LabelListResult,
  LabelSummary,
  RetryResult,
  SharedDriveListResult,
  SharedDriveTestResult,
} from "@/lib/google-drive";
import type { DriveExportListItem } from "@/lib/integrations/google/drive-export";

// Settings, Google Workspace, Google Drive, and the onboarding step of the
// same name: a checklist of what to set up in Google's consoles, with this
// site's own values to paste there, the settings themselves, live checks,
// and the state of each executed-copy export with a way to retry it.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const CLOUD_LIBRARY_URL = "https://console.cloud.google.com/apis/library";
const CLOUD_CREDENTIALS_URL =
  "https://console.cloud.google.com/apis/credentials";
const DRIVE_UI_URL =
  "https://console.cloud.google.com/apis/api/drive.googleapis.com/drive_sdk";
const DATA_ACCESS_URL = "https://console.cloud.google.com/auth/scopes";
const MARKETPLACE_SDK_URL =
  "https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com/googleapps_sdk";
const ADMIN_LABELS_URL = "https://admin.google.com/ac/dc/labels";
const ADMIN_DRIVE_SHARING_URL =
  "https://admin.google.com/ac/managedsettings/55656082996/sharing";
const ADMIN_DELEGATION_URL =
  "https://admin.google.com/ac/owl/domainwidedelegation";
const LABEL_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.labels.readonly",
];

type Notice = { message: string; tone: "error" | "success" } | null;

type SaveFields = Partial<{
  appId: string;
  exportDriveId: string;
  exportFolderPattern: string;
  labelFields: Record<string, string>;
  labelId: string;
  labelsSubject: string;
  pickerApiKey: string;
}>;

function StatusPill({ children, ok }: { children: ReactNode; ok: boolean }) {
  return (
    <span className={`pill ${ok ? "pill-success" : "pill-warning"}`}>
      {children}
    </span>
  );
}

function Feedback({ notice }: { notice: Notice }) {
  if (!notice) {
    return null;
  }

  return <KitNotice tone={notice.tone}>{notice.message}</KitNotice>;
}

function fromEnv(name: string) {
  return `Set by the ${name} environment variable.`;
}

async function postAction<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const response = await fetch("/api/admin/drive", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

async function fetchExports(): Promise<DriveExportListItem[] | null> {
  return readExports(
    await postAction<{ exports?: DriveExportListItem[] }>({
      action: "list_exports",
    }),
  );
}

function formatTime(seconds: number | null): string {
  return seconds
    ? new Date(seconds * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
}

/** Settings, Integrations, Google Drive. */
export function GoogleDrivePanel({
  detail,
  initialView,
  status,
}: {
  detail: string;
  initialView: GoogleDriveView;
  status: ConnectionStatus;
}) {
  return (
    <IntegrationPanel
      brand="google-drive"
      description="Start an envelope from a file in Drive, open files from Drive with this site, and keep a copy of every executed envelope in a Shared Drive. Each part is optional and stays off until it is set up."
      detail={detail}
      id="google-drive"
      name="Google Drive"
      status={status}
    >
      <GoogleDriveSection initialView={initialView} />
    </IntegrationPanel>
  );
}

/** Google Drive's steps, in Settings and in onboarding. */
export function GoogleDriveSection({
  initialView,
}: {
  initialView: GoogleDriveView;
}) {
  const [view, setView] = useState(initialView);
  const [values, setValues] = useState({
    appId:
      initialView.picker.appIdSource === "settings"
        ? (initialView.picker.appId ?? "")
        : "",
    exportDriveId:
      initialView.export.driveIdSource === "settings"
        ? (initialView.export.driveId ?? "")
        : "",
    exportFolderPattern:
      initialView.export.folderPatternSource === "settings"
        ? initialView.export.folderPattern
        : "",
    labelsSubject: initialView.labels.subjectFromEnv
      ? ""
      : (initialView.labels.subject ?? ""),
    pickerApiKey:
      initialView.picker.apiKeySource === "settings"
        ? (initialView.picker.apiKey ?? "")
        : "",
  });
  const [labelId, setLabelId] = useState(initialView.labels.labelId ?? "");
  const [labelFields, setLabelFields] = useState<Record<string, string>>(
    initialView.labels.fields,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [drives, setDrives] = useState<SharedDriveListResult | null>(null);
  const [driveTest, setDriveTest] = useState<SharedDriveTestResult | null>(
    null,
  );
  const [labels, setLabels] = useState<LabelListResult | null>(null);
  const [exportList, setExports] = useState<DriveExportListItem[] | null>(null);
  const [exportsFailed, setExportsFailed] = useState(false);
  const exportsEnabled = view.export.driveId !== null;

  function change(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: "" }));
      setNotice(null);
    };
  }

  async function save(action: string, fields: SaveFields, done: string) {
    setPending(action);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/drive", {
        body: JSON.stringify(fields),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        view?: GoogleDriveView;
      } | null;

      if (!response.ok || !payload?.view) {
        setErrors(payload?.fieldErrors ?? {});
        setNotice({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setView(payload.view);
      setErrors({});
      setNotice({ message: done, tone: "success" });
    } catch {
      setNotice({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPending(null);
    }
  }

  function applyExports(list: DriveExportListItem[] | null) {
    setExportsFailed(list === null);

    if (list === null) {
      setNotice({ message: "Could not load the export list.", tone: "error" });
    } else {
      setExports(list);
    }
  }

  async function loadExports() {
    applyExports(await fetchExports());
  }

  useEffect(() => {
    if (!exportsEnabled) {
      return;
    }

    let cancelled = false;

    void fetchExports().then((list) => {
      if (!cancelled) {
        applyExports(list);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [exportsEnabled]);

  async function run<T>(
    action: string,
    body: Record<string, unknown>,
    apply: (result: T) => void,
  ) {
    setPending(action);

    const payload = await postAction<{ error?: string; result?: T }>(body);

    setPending(null);

    if (payload?.result) {
      apply(payload.result);
    } else {
      setNotice({
        message: payload?.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    }
  }

  async function retry(envelopeId: string) {
    await run<RetryResult>(
      `retry:${envelopeId}`,
      { action: "retry_export", envelopeId },
      (result) => {
        setNotice(
          result.ok
            ? {
                message:
                  result.status === "exported"
                    ? "Exported."
                    : "Tried again; it did not go through yet. The error is shown below.",
                tone: result.status === "exported" ? "success" : "error",
              }
            : { message: result.message, tone: "error" },
        );
      },
    );
    await loadExports();
  }

  const selectedLabel: LabelSummary | null =
    labels?.ok === true
      ? (labels.labels.find((item) => item.id === labelId) ?? null)
      : null;
  const labelLocked = view.labels.source === "env";

  return (
    <div className="space-y-5">
      <Feedback notice={notice} />

      <SetupSteps>
        <CheckItem ok={view.available} title="1. In the Google Cloud project">
          {view.available ? null : (
            <p>
              Set up Google sign-in first (Integrations, Google sign-in): each
              person connects Drive with the same OAuth client.
            </p>
          )}
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the{" "}
              <ExternalLink href={CLOUD_LIBRARY_URL}>API library</ExternalLink>,
              enable the <strong>Google Drive API</strong>, the{" "}
              <strong>Google Picker API</strong> and, for labels, the{" "}
              <strong>Drive Labels API</strong>.
            </li>
            <li>
              In{" "}
              <ExternalLink href={DATA_ACCESS_URL}>
                Google Auth Platform, Data access
              </ExternalLink>
              , add the scope{" "}
              <code>https://www.googleapis.com/auth/drive.file</code>. It only
              reaches files a person opens with, or picks in, this site.
            </li>
            <li>
              In the sign-in OAuth client, add a second authorized redirect URI:
              {view.callbackUri ? (
                <CopyValue label="Redirect URI" value={view.callbackUri} />
              ) : (
                <span className="block">
                  This site does not know its own address yet. Set APP_URL (or
                  BETTER_AUTH_URL).
                </span>
              )}
            </li>
          </ol>
        </CheckItem>

        <CheckItem
          ok={view.picker.ready}
          title="2. Start from Google Drive (the Picker)"
        >
          <p>
            Adds &quot;Choose from Google Drive&quot; to the new-envelope page.
            Google Docs, Word and PDF files become a draft. In{" "}
            <ExternalLink href={CLOUD_CREDENTIALS_URL}>
              Credentials
            </ExternalLink>
            , create an <strong>API key</strong>, restrict it to the Google
            Picker API and to this site&apos;s address, and paste it here with
            the project <strong>number</strong> (on the project&apos;s
            dashboard).
          </p>
          {view.siteUrl ? (
            <CopyValue
              label="Website restriction"
              value={`${view.siteUrl}/*`}
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              autoComplete="off"
              disabled={pending !== null || view.picker.apiKeySource === "env"}
              error={errors.pickerApiKey}
              helper={
                view.picker.apiKeySource === "env"
                  ? fromEnv("GOOGLE_PICKER_API_KEY")
                  : "Sent to the browser, so restrict it to the Picker API and this site."
              }
              label="Browser API key"
              name="drive-picker-api-key"
              onChange={change("pickerApiKey")}
              placeholder="AIza..."
              readOnly={view.picker.apiKeySource === "env"}
              value={
                view.picker.apiKeySource === "env"
                  ? (view.picker.apiKey ?? "")
                  : values.pickerApiKey
              }
            />
            <FieldShell
              disabled={pending !== null || view.picker.appIdSource === "env"}
              error={errors.appId}
              helper={
                view.picker.appIdSource === "env"
                  ? fromEnv("GOOGLE_DRIVE_APP_ID")
                  : "The Cloud project's number (the Picker's app ID)."
              }
              label="Project number"
              name="drive-app-id"
              onChange={change("appId")}
              placeholder="123456789012"
              readOnly={view.picker.appIdSource === "env"}
              value={
                view.picker.appIdSource === "env"
                  ? (view.picker.appId ?? "")
                  : values.appId
              }
            />
          </div>
          <ShellButton
            disabled={pending !== null}
            loading={pending === "picker"}
            onClick={() =>
              void save(
                "picker",
                {
                  ...(view.picker.apiKeySource === "env"
                    ? {}
                    : { pickerApiKey: values.pickerApiKey }),
                  ...(view.picker.appIdSource === "env"
                    ? {}
                    : { appId: values.appId }),
                },
                "Saved. The new-envelope page offers Google Drive to everyone who signs in with Google.",
              )
            }
            variant="secondary"
          >
            Save Picker settings
          </ShellButton>
        </CheckItem>

        <CheckItem
          ok={null}
          title='3. Optional: "Open with" this site in Drive'
        >
          <p>
            In the Cloud console, open the{" "}
            <ExternalLink href={DRIVE_UI_URL}>
              Google Drive API, Drive UI integration
            </ExternalLink>{" "}
            page, fill in the application name and icons, and enter exactly
            these values. Tick <strong>Importing</strong> so Google Docs can be
            opened too; Drive then hands this site the document as a PDF.
          </p>
          {view.openUrl ? (
            <CopyValue label="Open URL" value={view.openUrl} />
          ) : (
            <p>
              Set APP_URL first: the open URL is this site&apos;s address
              followed by /api/google/drive/open.
            </p>
          )}
          <CopyValue
            label="Default MIME types"
            value={view.openWith.defaultMimeTypes.join(",")}
          />
          <CopyValue
            label="Default file extensions"
            value={view.openWith.defaultExtensions.join(",")}
          />
          <CopyValue
            label="Secondary MIME types"
            value={view.openWith.secondaryMimeTypes.join(",")}
          />
          <CopyValue
            label="Secondary file extensions"
            value={view.openWith.secondaryExtensions.join(",")}
          />
          <CopyValue
            label="Import formats"
            value={view.openWith.importFormats.join(",")}
          />
          <p>
            For &quot;Open with&quot; to show up for everyone, list the app
            privately for your organization with the{" "}
            <ExternalLink href={MARKETPLACE_SDK_URL}>
              Google Workspace Marketplace SDK
            </ExternalLink>{" "}
            (with the Drive integration on and the drive.file scope), and
            install it for the domain from the Admin console. Someone who opens
            a file is asked to sign in here and to connect Drive the first time.
          </p>
        </CheckItem>

        <CheckItem
          ok={
            exportsEnabled
              ? driveTest?.ok
                ? driveTest.canAddChildren
                : null
              : null
          }
          title="4. Optional: executed copies in a Shared Drive"
        >
          <p>
            When an envelope is completed, its sealed PDF and its audit
            certificate are put in a Shared Drive by this site&apos;s service
            account. Failed uploads are tried again (see below), and a retry
            never makes a second copy.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open the Shared Drive in Drive, choose Manage members, and add the
              service account as a <strong>Content manager</strong>:
              {view.serviceAccountEmail ? (
                <CopyValue
                  label="Service account"
                  value={view.serviceAccountEmail}
                />
              ) : (
                <span className="block">
                  This site has no Google credentials: run it on Google Cloud as
                  its own service account, or set GOOGLE_SERVICE_ACCOUNT_KEY.
                </span>
              )}
            </li>
            <li>
              A service account is not part of your Workspace. If adding it is
              refused, allow members outside your organization for this Shared
              Drive: in the{" "}
              <ExternalLink href={ADMIN_DRIVE_SHARING_URL}>
                Admin console, Drive and Docs, Sharing settings
              </ExternalLink>
              , let shared drives have members from outside (for the
              organizational unit that owns the drive), and in the Shared
              Drive&apos;s own settings, allow people outside the organization.
            </li>
            <li>Choose the Shared Drive below, or paste its ID, and save.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <ShellButton
              disabled={pending !== null || !view.serviceAccountEmail}
              loading={pending === "list_drives"}
              onClick={() =>
                void run<SharedDriveListResult>(
                  "list_drives",
                  { action: "list_drives" },
                  setDrives,
                )
              }
              variant="ghost"
            >
              List the Shared Drives it can see
            </ShellButton>
          </div>
          {drives ? (
            drives.ok ? (
              drives.drives.length > 0 ? (
                <ul className="space-y-1">
                  {drives.drives.map((drive) => (
                    <li
                      className="flex flex-wrap items-center gap-2"
                      key={drive.id}
                    >
                      <span className="font-semibold text-(--fg)">
                        {drive.name}
                      </span>
                      <code className="text-xs">{drive.id}</code>
                      <button
                        className="btn-quiet"
                        disabled={view.export.driveIdSource === "env"}
                        onClick={() =>
                          setValues((current) => ({
                            ...current,
                            exportDriveId: drive.id,
                          }))
                        }
                        type="button"
                      >
                        Use this one
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  The service account is not a member of any Shared Drive yet.
                </p>
              )
            ) : (
              <Feedback notice={{ message: drives.message, tone: "error" }} />
            )
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={pending !== null || view.export.driveIdSource === "env"}
              error={errors.exportDriveId}
              helper={
                view.export.driveIdSource === "env"
                  ? fromEnv("GOOGLE_DRIVE_EXPORT_DRIVE_ID")
                  : "Empty turns executed copies off."
              }
              label="Shared Drive ID"
              name="drive-export-drive-id"
              onChange={change("exportDriveId")}
              placeholder="0AAbCdEfGhIjKUk9PVA"
              readOnly={view.export.driveIdSource === "env"}
              value={
                view.export.driveIdSource === "env"
                  ? (view.export.driveId ?? "")
                  : values.exportDriveId
              }
            />
            <FieldShell
              disabled={
                pending !== null || view.export.folderPatternSource === "env"
              }
              error={errors.exportFolderPattern}
              helper={
                view.export.folderPatternSource === "env"
                  ? fromEnv("GOOGLE_DRIVE_EXPORT_FOLDER_PATTERN")
                  : "Folders, then the file's name. {yyyy} {MM} {dd} {yyyy-MM} {yyyy-MM-dd} {title} {shortId} {envelopeId} {senderEmail}; dates in UTC."
              }
              label="Folder layout"
              name="drive-export-pattern"
              onChange={change("exportFolderPattern")}
              placeholder={view.export.defaultPattern}
              readOnly={view.export.folderPatternSource === "env"}
              value={
                view.export.folderPatternSource === "env"
                  ? view.export.folderPattern
                  : values.exportFolderPattern
              }
            />
          </div>
          <p>
            For example: <code>{view.export.preview}</code>, with the
            certificate beside it.
          </p>
          <div className="flex flex-wrap gap-2">
            <ShellButton
              disabled={pending !== null}
              loading={pending === "export"}
              onClick={() =>
                void save(
                  "export",
                  {
                    ...(view.export.driveIdSource === "env"
                      ? {}
                      : { exportDriveId: values.exportDriveId }),
                    ...(view.export.folderPatternSource === "env"
                      ? {}
                      : { exportFolderPattern: values.exportFolderPattern }),
                  },
                  "Saved. Envelopes completed from now on are copied to the Shared Drive.",
                )
              }
              variant="secondary"
            >
              Save executed copies
            </ShellButton>
            <ShellButton
              disabled={pending !== null || !view.serviceAccountEmail}
              loading={pending === "test_drive"}
              onClick={() =>
                void run<SharedDriveTestResult>(
                  "test_drive",
                  {
                    action: "test_drive",
                    driveId: values.exportDriveId || view.export.driveId || "",
                  },
                  setDriveTest,
                )
              }
            >
              Test Shared Drive access
            </ShellButton>
          </div>
          {driveTest ? (
            driveTest.ok ? (
              <Feedback
                notice={
                  driveTest.canAddChildren
                    ? {
                        message: `The service account can add files to "${driveTest.name}".`,
                        tone: "success",
                      }
                    : {
                        message: `The service account can see "${driveTest.name}" but cannot add files. Make it a Content manager.`,
                        tone: "error",
                      }
                }
              />
            ) : (
              <Feedback
                notice={{ message: driveTest.message, tone: "error" }}
              />
            )
          ) : null}
        </CheckItem>

        <CheckItem
          ok={null}
          title="5. Optional: a Drive label on executed copies"
        >
          <p>
            Make and publish a label in the{" "}
            <ExternalLink href={ADMIN_LABELS_URL}>
              Admin console, Labels
            </ExternalLink>
            , and let it be applied in the Shared Drive. Then pick it here and
            say what goes in each field. A label that cannot be applied is noted
            on the export; the copy itself is still made.
          </p>
          <p>
            The service account reads labels with the Drive Labels API and
            applies them with the Drive API. If the label&apos;s permissions do
            not reach the service account, give it{" "}
            <ExternalLink href={ADMIN_DELEGATION_URL}>
              domain-wide delegation
            </ExternalLink>{" "}
            for exactly these scopes and name a user who may apply the label and
            is a member of the Shared Drive:
          </p>
          <CopyValue label="Label scopes" value={LABEL_SCOPES.join(",")} />
          <div className="max-w-xl">
            <FieldShell
              disabled={pending !== null || view.labels.subjectFromEnv}
              error={errors.labelsSubject}
              helper={
                view.labels.subjectFromEnv
                  ? fromEnv("GOOGLE_DRIVE_LABELS_SUBJECT")
                  : "Only with domain-wide delegation. Empty: the service account applies labels as itself."
              }
              label="Apply labels as"
              name="drive-labels-subject"
              onChange={change("labelsSubject")}
              placeholder="records@yourcompany.com"
              readOnly={view.labels.subjectFromEnv}
              value={
                view.labels.subjectFromEnv
                  ? (view.labels.subject ?? "")
                  : values.labelsSubject
              }
            />
          </div>
          {labelLocked ? (
            <p>
              {fromEnv("GOOGLE_DRIVE_LABEL_ID")} Label{" "}
              <code>{view.labels.labelId}</code>, fields from
              GOOGLE_DRIVE_LABEL_FIELDS.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <ShellButton
                  disabled={pending !== null || !view.serviceAccountEmail}
                  loading={pending === "list_labels"}
                  onClick={() =>
                    void run<LabelListResult>(
                      "list_labels",
                      { action: "list_labels" },
                      setLabels,
                    )
                  }
                  variant="ghost"
                >
                  Load labels
                </ShellButton>
              </div>
              {labels && !labels.ok ? (
                <Feedback notice={{ message: labels.message, tone: "error" }} />
              ) : null}
              {labels?.ok ? (
                <label className="block space-y-1">
                  <span className="text-sm font-bold text-(--fg)">Label</span>
                  <select
                    className="w-full max-w-xl rounded-xl border border-(--border-strong) bg-white px-3 py-2 text-sm text-(--fg)"
                    onChange={(event) => setLabelId(event.target.value)}
                    value={labelId}
                  >
                    <option value="">No label</option>
                    {labels.labels.map((label) => (
                      <option key={label.id} value={label.id}>
                        {label.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : view.labels.labelId ? (
                <p>
                  Label <code>{view.labels.labelId}</code> is set. Load labels
                  to change it or its fields.
                </p>
              ) : null}
              {selectedLabel ? (
                <div className="space-y-2">
                  {selectedLabel.fields.map((field) => (
                    <label
                      className="flex flex-wrap items-center gap-3"
                      key={field.id}
                    >
                      <span className="min-w-40 text-sm font-semibold text-(--fg)">
                        {field.name}{" "}
                        <span className="text-xs font-normal text-(--tertiary)">
                          ({field.kind ?? "not supported"})
                        </span>
                      </span>
                      <select
                        className="rounded-xl border border-(--border-strong) bg-white px-3 py-2 text-sm text-(--fg)"
                        disabled={
                          field.kind === null || field.kind === "integer"
                        }
                        onChange={(event) =>
                          setLabelFields((current) => ({
                            ...current,
                            [field.id]: event.target.value,
                          }))
                        }
                        value={labelFields[field.id] ?? ""}
                      >
                        <option value="">Leave empty</option>
                        {view.labels.sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {errors.labelFields ? (
                    <Feedback
                      notice={{ message: errors.labelFields, tone: "error" }}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          <ShellButton
            disabled={pending !== null}
            loading={pending === "labels"}
            onClick={() =>
              void save(
                "labels",
                {
                  ...(view.labels.subjectFromEnv
                    ? {}
                    : { labelsSubject: values.labelsSubject }),
                  ...(labelLocked || !labels?.ok
                    ? {}
                    : {
                        labelFields: selectedLabel
                          ? Object.fromEntries(
                              Object.entries(labelFields).filter(([fieldId]) =>
                                selectedLabel.fields.some(
                                  (field) => field.id === fieldId,
                                ),
                              ),
                            )
                          : {},
                        labelId,
                      }),
                },
                "Saved. The label is applied to executed copies from now on.",
              )
            }
            variant="secondary"
          >
            Save label settings
          </ShellButton>
        </CheckItem>
      </SetupSteps>

      {exportsEnabled || (exportList && exportList.length > 0) ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h4 className="text-base font-extrabold text-(--fg)">
              Executed copies
            </h4>
            <button
              className="btn-quiet"
              onClick={() => void loadExports()}
              type="button"
            >
              Refresh
            </button>
          </div>
          {exportsView(exportList, exportsFailed) === "loading" ? (
            <p className="text-sm text-(--secondary)">Loading...</p>
          ) : exportsView(exportList, exportsFailed) === "failed" ? (
            <p className="text-sm text-(--secondary)">
              Could not load the list. Use Refresh to try again.
            </p>
          ) : exportList === null || exportList.length === 0 ? (
            <p className="text-sm text-(--secondary)">
              Nothing exported yet. Envelopes completed from now on show here.
            </p>
          ) : (
            <ul className="space-y-2">
              {exportList.map((item) => (
                <li
                  className="space-y-1 rounded-2xl bg-(--surface) px-4 py-3 text-sm"
                  key={item.envelopeId}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      className="font-semibold text-(--fg) underline underline-offset-4"
                      href={`/envelopes/${item.envelopeId}`}
                    >
                      {item.title}
                    </a>
                    <StatusPill ok={item.status === "exported"}>
                      {item.status === "exported"
                        ? "Exported"
                        : item.status === "failed"
                          ? "Gave up"
                          : `Waiting (try ${String(item.attempts + 1)})`}
                    </StatusPill>
                    {item.status === "exported" && item.signedPdfFileId ? (
                      <ExternalLink
                        href={`https://drive.google.com/file/d/${item.signedPdfFileId}/view`}
                      >
                        Open in Drive
                      </ExternalLink>
                    ) : null}
                    <button
                      className="btn-quiet"
                      disabled={pending !== null}
                      onClick={() => void retry(item.envelopeId)}
                      type="button"
                    >
                      {pending === `retry:${item.envelopeId}`
                        ? "Trying..."
                        : "Try again"}
                    </button>
                  </div>
                  <p className="text-xs text-(--secondary)">
                    {item.status === "exported"
                      ? `Exported ${formatTime(item.exportedAt)}`
                      : item.status === "pending"
                        ? `Next try ${formatTime(item.nextAttemptAt)}`
                        : `Last tried ${formatTime(item.nextAttemptAt)}`}
                    {item.lastError ? ` — ${item.lastError}` : ""}
                    {item.labelStatus && item.labelStatus !== "applied"
                      ? ` — label ${item.labelStatus}${item.labelError ? `: ${item.labelError}` : ""}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
