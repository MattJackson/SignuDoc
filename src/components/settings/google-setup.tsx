"use client";

import {
  CheckIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useBranding } from "@/components/layout/branding-provider";
import {
  ActionRow,
  CheckItem,
  CopyValue,
  ExternalButton,
  ExternalLink,
  linkClassName,
  Notice,
  SetupSteps,
  TestResult,
} from "@/components/settings/integration-kit";
import { useGoogleWorkspace } from "@/components/settings/google-workspace-panel";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { needsCustomerId, OWN_GOOGLE_CUSTOMER } from "@/lib/google-customer";
import { apiLibraryUrl, consoleUrl, originOf } from "@/lib/google-console";
import type { GoogleDriveView } from "@/lib/google-drive";
import type { GoogleWorkspaceView } from "@/lib/google-workspace";
import type { SetupTargetView } from "@/lib/google-workspace-setup";
import {
  directoryRoleName,
  DRIVE_CALLBACK_PATH,
  executedDriveName,
  pickerKeyName,
  SETUP_APIS,
  SETUP_CALLBACK_PATH,
  SETUP_STEP_ORDER,
  SETUP_STEP_TITLES,
  SSO_CALLBACK_PATH,
  type SetupEvent,
  type SetupStepId,
  type SetupStepStatus,
} from "@/lib/integrations/google/workspace-setup-names";

// Google Workspace setup, in onboarding and at /settings/google-setup:
// Automatic (one copy-paste step for the OAuth client, then one sign-in as
// a super admin that does the rest on the server) or Manual (the same
// steps a to f, each a link, values to copy, a field to paste into and a
// test). Drive's "Open with" and the Marketplace listing have no API and
// stay an optional manual step at the end.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const ADMIN_ROLES_URL = "https://admin.google.com/ac/roles";
const ADMIN_ACCOUNT_SETTINGS_URL =
  "https://admin.google.com/ac/accountsettings/profile";
const SHARED_DRIVES_URL = "https://drive.google.com/drive/shared-drives";
const DRIVE_UI_PATH = "/apis/api/drive.googleapis.com/drive_sdk";
const INTERRUPTED_MESSAGE = "The setup stopped before it finished.";
const INTERRUPTED_HINT =
  "Run it again; what is done already is kept. The one-time Google sign-in was never stored, and it expires within the hour.";

export type GoogleSetupCallback = {
  code: string | null;
  error: string | null;
  state: string | null;
};

type GoogleSetupProps = {
  /** What Google sent back after the one-time sign-in, on the setup page. */
  callback?: GoogleSetupCallback | null;
  drive: GoogleDriveView;
  /** Called after something was saved, so the page is read again. */
  onChanged?: () => void;
  /** Where to come back to after the automatic setup. */
  returnTo: string;
  target: SetupTargetView;
  workspace: GoogleWorkspaceView;
};

type StepState = {
  detail: string;
  googleStatus?: number | null;
  hint?: string;
  status: SetupStepStatus;
};

type RunState = {
  finished: { ok: boolean; revoked: boolean } | null;
  refused: { hint?: string; message: string } | null;
  returnTo: string | null;
  running: boolean;
  steps: Partial<Record<SetupStepId, StepState>>;
};

const EMPTY_RUN: RunState = {
  finished: null,
  refused: null,
  returnTo: null,
  running: false,
  steps: {},
};

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "The Google sign-in was cancelled. Nothing was changed.",
  not_ready:
    "The automatic setup cannot start yet. Finish step A, and check the notes above.",
};

/** Runs the setup with the code Google sent back, reading each step live. */
function useSetupRun(callback: GoogleSetupCallback | null | undefined) {
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !callback?.code || !callback.state) {
      return;
    }

    started.current = true;

    const { code, state } = callback;

    // The code is used once; it should not stay in the address bar.
    window.history.replaceState(null, "", window.location.pathname);

    void (async () => {
      setRun({ ...EMPTY_RUN, running: true });

      let streamed = false;

      try {
        const response = await fetch("/api/admin/google/setup/run", {
          body: JSON.stringify({ code, state }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;

          setRun({
            ...EMPTY_RUN,
            refused: { message: payload?.error ?? GENERIC_ERROR_MESSAGE },
          });
          return;
        }

        const reader = response.body.getReader();

        streamed = true;

        const decoder = new TextDecoder();
        let buffered = "";

        for (;;) {
          const { done, value } = await reader.read();

          buffered += decoder.decode(value, { stream: !done });

          const lines = buffered.split("\n");

          buffered = lines.pop() ?? "";

          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line) as
              SetupEvent | { returnTo: string; type: "start" };

            setRun((current) => apply(current, event));
          }

          if (done) {
            break;
          }
        }
      } catch {
        setRun((current) => ({
          ...current,
          refused: current.refused ?? { message: GENERIC_ERROR_MESSAGE },
        }));
      } finally {
        // A stream cut off before the end (a time limit, a proxy) sends no
        // "finished": say so, rather than leave steps at "Working".
        setRun((current) =>
          current.finished || !streamed
            ? { ...current, running: false }
            : {
                ...current,
                refused: {
                  hint: current.refused?.hint ?? INTERRUPTED_HINT,
                  message: current.refused?.message ?? INTERRUPTED_MESSAGE,
                },
                running: false,
              },
        );
      }
    })();
  }, [callback]);

  return run;
}

function apply(
  current: RunState,
  event: SetupEvent | { returnTo: string; type: "start" },
): RunState {
  switch (event.type) {
    case "start":
      return { ...current, returnTo: event.returnTo };
    case "step":
      return {
        ...current,
        steps: {
          ...current.steps,
          [event.id]: {
            detail: event.detail,
            googleStatus: event.googleStatus,
            hint: event.hint,
            status: event.status,
          },
        },
      };
    case "refused":
      return {
        ...current,
        refused: { hint: event.hint, message: event.message },
      };
    case "finished":
      return {
        ...current,
        finished: { ok: event.ok, revoked: event.revoked },
        running: false,
      };
  }
}

const STATUS_LABELS: Record<SetupStepStatus | "waiting", string> = {
  done: "Done",
  failed: "Failed",
  running: "Working",
  skipped: "Already done",
  waiting: "Waiting",
};

function StatusIcon({ status }: { status: SetupStepStatus | "waiting" }) {
  const Icon =
    status === "done"
      ? CheckIcon
      : status === "failed"
        ? TriangleAlertIcon
        : status === "running"
          ? LoaderCircleIcon
          : status === "skipped"
            ? MinusIcon
            : CircleDashedIcon;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
        status === "done" || status === "skipped"
          ? "bg-(--success-soft) text-(--success)"
          : status === "failed"
            ? "bg-(--danger-soft) text-(--danger)"
            : "bg-(--paper) text-(--secondary) ring-1 ring-(--border-strong)",
      )}
    >
      <Icon
        className={cn("size-3.5", status === "running" && "animate-spin")}
      />
    </span>
  );
}

function RunResults({ run }: { run: RunState }) {
  return (
    <div aria-live="polite" className="space-y-3">
      <ol className="space-y-2">
        {SETUP_STEP_ORDER.map((id, index) => {
          const step = run.steps[id];
          const status = step?.status ?? "waiting";

          return (
            <li
              className="flex gap-3 rounded-2xl bg-(--surface) px-4 py-3"
              key={id}
            >
              <StatusIcon status={status} />
              <div className="min-w-0 flex-1 space-y-1 text-sm leading-6">
                <p className="font-bold text-(--fg)">
                  {String.fromCharCode(97 + index)}. {SETUP_STEP_TITLES[id]}{" "}
                  <span className="text-xs font-semibold text-(--tertiary)">
                    {STATUS_LABELS[status]}
                  </span>
                </p>
                {step?.detail ? (
                  <p className="text-(--secondary)">
                    {step.detail}
                    {step.googleStatus
                      ? ` (Google answered ${String(step.googleStatus)}.)`
                      : ""}
                  </p>
                ) : null}
                {step?.hint ? (
                  <p className="text-(--tertiary)">{step.hint}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {run.refused ? (
        <Notice tone="error">
          <p>{run.refused.message}</p>
          {run.refused.hint ? <p>{run.refused.hint}</p> : null}
        </Notice>
      ) : null}
      {run.finished ? (
        <Notice tone={run.finished.ok ? "success" : "warning"}>
          <p>
            {run.finished.ok
              ? "Everything is set up."
              : "Not everything could be set up. Fix what is marked above and run the setup again; what is done already is kept."}{" "}
            {run.finished.revoked
              ? "The one-time Google sign-in has been revoked, and it was never stored."
              : "The one-time token was never stored and expires within the hour."}
          </p>
        </Notice>
      ) : null}
    </div>
  );
}

function ModeChoice({
  mode,
  onChange,
}: {
  mode: "automatic" | "manual";
  onChange: (mode: "automatic" | "manual") => void;
}) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">How to set up Google Workspace</legend>
      {(
        [
          [
            "automatic",
            "Automatic",
            "Paste one OAuth client, then sign in once as a super admin. This site turns on the APIs, makes the Picker key, the directory role and the Shared Drive, and tests them.",
          ],
          [
            "manual",
            "Manual",
            "Do each step yourself in Google's consoles, with links, values to copy and a test for each.",
          ],
        ] as const
      ).map(([value, title, description]) => (
        <label
          className="flex cursor-pointer gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
          key={value}
        >
          <input
            checked={mode === value}
            className="mt-1 size-4 accent-(--accent)"
            name="google-setup-mode"
            onChange={() => onChange(value)}
            type="radio"
          />
          <span className="space-y-1">
            <span className="block text-sm font-bold text-(--fg)">{title}</span>
            <span className="block text-sm leading-6 text-(--secondary)">
              {description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Step A: the consent screen and the OAuth client, which have no API. */
function ClientStep({
  target,
  workspace,
}: {
  target: SetupTargetView;
  workspace: GoogleWorkspaceView;
}) {
  const { productName } = useBranding();
  const { error, save, view } = useGoogleWorkspace(workspace);
  const [clientId, setClientId] = useState(view.signIn.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const project = target.projectId;
  const site = target.siteUrl;
  const locked = view.signIn.source === "env";

  async function submit() {
    setPending(true);
    setSaved(false);

    const result = await save({
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      issuer: "https://accounts.google.com",
    });

    setPending(false);

    if (result.ok) {
      setClientSecret("");
      setSaved(true);
    }
  }

  return (
    <CheckItem
      ok={view.signIn.ready && view.signIn.google}
      title="A. Create the consent screen and the sign-in client"
    >
      <p>
        Google has no API for these two, so they are done by hand, once. The
        links open {project ? <strong>{project}</strong> : "your project"}.
        Everything else follows from this client.
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <ExternalLink href={consoleUrl("/auth/overview", project)}>
            Open Google Auth Platform
          </ExternalLink>
          , choose <strong>Get started</strong>, paste the app name, pick your
          support address and choose <strong>Internal</strong> as the audience.
        </li>
        <li>
          <ExternalLink href={consoleUrl("/auth/clients/create", project)}>
            Create an OAuth client
          </ExternalLink>
          : <strong>Web application</strong>, named as below, with the
          JavaScript origin and all three redirect URIs. Then choose Create.
        </li>
        <li>Paste the client ID and secret here and save.</li>
      </ol>
      <div className="grid gap-4">
        <CopyValue
          hint="The app name and the client name."
          label="App name"
          value={productName}
        />
        {site ? (
          <>
            <CopyValue
              hint="Under Authorized JavaScript origins."
              label="JavaScript origin"
              value={originOf(site) ?? site}
            />
            <CopyValue
              hint="Authorized redirect URI 1: Google sign-in."
              label="Sign-in redirect URI"
              value={`${site}${SSO_CALLBACK_PATH}`}
            />
            <CopyValue
              hint="Authorized redirect URI 2: connecting Google Drive."
              label="Drive redirect URI"
              value={`${site}${DRIVE_CALLBACK_PATH}`}
            />
            {target.redirectUri ? (
              <CopyValue
                hint="Authorized redirect URI 3: this automatic setup."
                label="Setup redirect URI"
                value={target.redirectUri}
              />
            ) : null}
          </>
        ) : (
          <Notice tone="warning">
            This site does not know its own address yet. Set APP_URL where it
            runs.
          </Notice>
        )}
      </div>
      {locked ? (
        <Notice tone="info">
          The client is set by SSO_CLIENT_ID and SSO_CLIENT_SECRET where the
          site runs.
        </Notice>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              autoComplete="off"
              disabled={pending}
              label="Client ID"
              name="setup-client-id"
              onChange={(event) => setClientId(event.target.value)}
              placeholder="1234-abc.apps.googleusercontent.com"
              readOnly={false}
              value={clientId}
            />
            <FieldShell
              autoComplete="off"
              disabled={pending}
              helper={
                view.signIn.hasClientSecret
                  ? "A secret is saved. Leave this empty to keep it."
                  : "Stored encrypted, and never shown again."
              }
              ignorePasswordManagers
              label="Client secret"
              name="setup-client-secret"
              onChange={(event) => setClientSecret(event.target.value)}
              readOnly={false}
              type="password"
              value={clientSecret}
            />
          </div>
          <ActionRow>
            <ShellButton
              disabled={pending || !clientId}
              loading={pending}
              onClick={() => void submit()}
              variant="secondary"
            >
              {pending ? "Saving..." : "Save the client"}
            </ShellButton>
          </ActionRow>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {saved && !error ? (
            <Notice tone="success">
              Saved. People can sign in with Google once the client is created;
              continue with step B.
            </Notice>
          ) : null}
        </div>
      )}
    </CheckItem>
  );
}

function AutomaticSetup({
  callback,
  drive,
  returnTo,
  target,
  workspace,
}: GoogleSetupProps) {
  const { productName } = useBranding();
  const run = useSetupRun(callback);
  const [exportDrive, setExportDrive] = useState(true);
  const callbackError = callback?.error
    ? (CALLBACK_ERRORS[callback.error] ??
      `Google did not finish the sign-in (${callback.error.slice(0, 60)}).`)
    : null;
  const showRun = run.running || run.finished !== null || run.refused !== null;
  const project = target.projectId;

  return (
    <SetupSteps>
      <ClientStep target={target} workspace={workspace} />

      <CheckItem
        ok={run.finished ? run.finished.ok : null}
        title="B. Sign in as a Workspace super admin and set everything up"
      >
        <p>
          You sign in once with a super admin who can also change the Cloud
          project (an Owner). This site then does steps a to f on its own and
          shows each as it goes, then revokes the sign-in. The token is never
          stored, and the setup can be run again at any time.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>a. Turn on {SETUP_APIS.length} Google APIs in the project.</li>
          <li>
            b. Create the Picker key &ldquo;{pickerKeyName(productName)}
            &rdquo;, held to the Picker API and this site.
          </li>
          <li>c. Read and save the Workspace customer ID.</li>
          <li>
            d. Create the admin role &ldquo;{directoryRoleName(productName)}
            &rdquo; (Users and Groups, read) and give it to{" "}
            {target.serviceAccountEmail ?? "the site's service account"}.
          </li>
          <li>
            e. Create the Shared Drive &ldquo;{executedDriveName(productName)}
            &rdquo; for executed copies, with the service account as Content
            manager.
          </li>
          <li>f. Test the directory, the admin group and the Shared Drive.</li>
        </ul>
        <label className="flex items-center gap-3 text-sm font-semibold text-(--fg)">
          <input
            checked={exportDrive}
            className="size-4 accent-(--accent)"
            onChange={(event) => setExportDrive(event.target.checked)}
            type="checkbox"
          />
          Keep executed copies in a Shared Drive
          {drive.export.driveId ? " (one is already set)" : ""}
        </label>
        {target.problem && target.clientReady ? (
          <Notice tone="warning">{target.problem}</Notice>
        ) : null}
        <ActionRow>
          {target.problem || run.running ? (
            <ShellButton disabled>Sign in with Google and set up</ShellButton>
          ) : (
            // A full page load: the route answers with a redirect to Google.
            <a
              className={cn(
                buttonVariants({ variant: "default" }),
                "min-h-12 w-fit px-5.5 text-[0.9375rem]",
              )}
              href={`/api/admin/google/setup/start?export=${exportDrive ? "1" : "0"}&returnTo=${encodeURIComponent(returnTo)}`}
            >
              {run.finished
                ? "Run the setup again"
                : "Sign in with Google and set up"}
            </a>
          )}
        </ActionRow>
        {!target.clientReady ? (
          <p className="text-xs leading-5 text-(--tertiary)">
            Available once the client from step A is saved.
          </p>
        ) : null}
        {callbackError ? <Notice tone="error">{callbackError}</Notice> : null}
        {showRun ? <RunResults run={run} /> : null}
        {run.finished &&
        run.returnTo &&
        run.returnTo !== SETUP_CALLBACK_PATH ? (
          <ShellButton href={run.returnTo} variant="secondary">
            Continue
          </ShellButton>
        ) : null}
      </CheckItem>

      <OptionalDriveStep project={project} />
    </SetupSteps>
  );
}

function OptionalDriveStep({ project }: { project: string | null }) {
  return (
    <CheckItem
      ok={null}
      optional
      title='Optional: "Open with" in Drive and the Marketplace listing'
    >
      <p>
        Google has no API for these either. To open PDFs from Drive with this
        site, fill in the Drive UI integration; to install the Gmail and Drive
        add-on for everyone, list it in the Workspace Marketplace. Settings,
        Google Drive and Gmail and Drive add-on have the values to paste.
      </p>
      <ActionRow>
        <ExternalButton href={consoleUrl(DRIVE_UI_PATH, project)}>
          Drive UI integration
        </ExternalButton>
        <ShellButton href="/settings/integrations/google-drive" variant="ghost">
          Google Drive settings
        </ShellButton>
      </ActionRow>
    </CheckItem>
  );
}

type TestOutcome = { message: ReactNode; ok: boolean } | null;

async function postJson<T>(url: string, body: unknown, method = "POST") {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
  const payload = (await response.json().catch(() => null)) as
    (T & { error?: string; fieldErrors?: Record<string, string> }) | null;

  return { ok: response.ok, payload };
}

/** A field to paste a value into, saved with one button. */
function PasteField({
  helper,
  label,
  name,
  onSave,
  placeholder,
  value: initial,
}: {
  helper?: string;
  label: string;
  name: string;
  onSave: (value: string) => Promise<string | null>;
  placeholder?: string;
  value: string;
}) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestOutcome>(null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <FieldShell
            autoComplete="off"
            disabled={pending}
            helper={helper}
            label={label}
            name={name}
            onChange={(event) => {
              setValue(event.target.value);
              setResult(null);
            }}
            placeholder={placeholder}
            readOnly={false}
            value={value}
          />
        </div>
        <ShellButton
          disabled={pending}
          loading={pending}
          onClick={async () => {
            setPending(true);

            const problem = await onSave(value.trim()).catch(
              () => GENERIC_ERROR_MESSAGE,
            );

            setPending(false);
            setResult(
              problem
                ? { message: problem, ok: false }
                : { message: "Saved.", ok: true },
            );
          }}
          variant="secondary"
        >
          Save
        </ShellButton>
      </div>
      <TestResult result={result} />
    </div>
  );
}

function TestButton({
  label,
  run,
}: {
  label: string;
  run: () => Promise<TestOutcome>;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestOutcome>(null);

  return (
    <div className="space-y-2">
      <ShellButton
        disabled={pending}
        loading={pending}
        onClick={async () => {
          setPending(true);
          setResult(
            await run().catch(() => ({
              message: GENERIC_ERROR_MESSAGE,
              ok: false,
            })),
          );
          setPending(false);
        }}
      >
        {pending ? "Testing..." : label}
      </ShellButton>
      <TestResult result={result} />
    </div>
  );
}

async function testDirectory(): Promise<TestOutcome> {
  const { payload } = await postJson<{
    result?:
      | { message: string; ok: false }
      | { ok: true; people: { email: string; name: string }[] };
  }>("/api/admin/google", { action: "test_directory" });
  const result = payload?.result;

  if (!result) {
    return { message: payload?.error ?? GENERIC_ERROR_MESSAGE, ok: false };
  }

  return result.ok
    ? {
        message: `The directory can be read. Found ${result.people.map((person) => person.email).join(", ")}.`,
        ok: true,
      }
    : { message: result.message, ok: false };
}

async function testDrive(): Promise<TestOutcome> {
  const { payload } = await postJson<{
    result?:
      | { message: string; ok: false }
      | { canAddChildren: boolean; name: string; ok: true };
  }>("/api/admin/drive", { action: "test_drive" });
  const result = payload?.result;

  if (!result) {
    return { message: payload?.error ?? GENERIC_ERROR_MESSAGE, ok: false };
  }

  return result.ok
    ? {
        message: result.canAddChildren
          ? `The service account can add files to "${result.name}".`
          : `"${result.name}" was found, but the service account cannot add files. Make it a Content manager.`,
        ok: result.canAddChildren,
      }
    : { message: result.message, ok: false };
}

async function saveWorkspace(fields: Record<string, string>) {
  const { ok, payload } = await postJson<unknown>(
    "/api/admin/google",
    fields,
    "PUT",
  );

  return ok
    ? null
    : (Object.values(payload?.fieldErrors ?? {})[0] ??
        payload?.error ??
        GENERIC_ERROR_MESSAGE);
}

async function saveDrive(fields: Record<string, string>) {
  const { ok, payload } = await postJson<unknown>(
    "/api/admin/drive",
    fields,
    "PUT",
  );

  return ok
    ? null
    : (Object.values(payload?.fieldErrors ?? {})[0] ??
        payload?.error ??
        GENERIC_ERROR_MESSAGE);
}

function ManualSetup({
  drive,
  onChanged,
  target,
  workspace,
}: GoogleSetupProps) {
  const { productName } = useBranding();
  const project = target.projectId;
  const site = target.siteUrl ? originOf(target.siteUrl) : null;
  const serviceAccount =
    target.serviceAccountEmail ?? "the site's service account";
  const saved = async (problem: Promise<string | null>) => {
    const result = await problem;

    if (!result) {
      onChanged?.();
    }

    return result;
  };

  return (
    <SetupSteps>
      <ClientStep target={target} workspace={workspace} />

      <CheckItem ok={null} title="a. Turn on the Google APIs">
        <p>
          Open each one and choose <strong>Enable</strong>. Ones already on say
          Manage.
        </p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {SETUP_APIS.map((api) => (
            <li key={api}>
              <ExternalLink href={apiLibraryUrl(api, project)}>
                {api}
              </ExternalLink>
            </li>
          ))}
        </ul>
      </CheckItem>

      <CheckItem ok={drive.picker.ready} title="b. Create the Picker's API key">
        <p>
          <ExternalLink href={consoleUrl("/apis/credentials", project)}>
            Open Credentials
          </ExternalLink>
          , choose <strong>Create credentials</strong>, <strong>API key</strong>
          . Name it as below, restrict it to <strong>Websites</strong> with this
          site, and to the <strong>Google Picker API</strong> only.
        </p>
        <div className="grid gap-4">
          <CopyValue label="Key name" value={pickerKeyName(productName)} />
          {site ? (
            <CopyValue label="Website restriction" value={`${site}/*`} />
          ) : null}
          {drive.projectNumber ? (
            <CopyValue
              hint="Saved with the key as the Picker's app ID."
              label="Project number"
              value={drive.projectNumber}
            />
          ) : null}
        </div>
        {drive.picker.apiKeySource === "env" ? (
          <Notice tone="info">
            GOOGLE_PICKER_API_KEY is set where the site runs.
          </Notice>
        ) : (
          <PasteField
            label="API key"
            name="setup-picker-key"
            onSave={(value) =>
              saved(
                saveDrive({
                  pickerApiKey: value,
                  ...(drive.picker.appIdSource !== "env" && drive.projectNumber
                    ? { appId: drive.projectNumber }
                    : {}),
                }),
              )
            }
            placeholder="AIza..."
            value={drive.picker.apiKey ?? ""}
          />
        )}
      </CheckItem>

      <CheckItem
        ok={needsCustomerId(workspace.directory) ? null : true}
        title="c. Paste the Workspace customer ID"
      >
        <p>
          It is under{" "}
          <ExternalLink href={ADMIN_ACCOUNT_SETTINGS_URL}>
            Admin console, Account, Account settings
          </ExternalLink>
          , and starts with C.
        </p>
        {workspace.directory.customerFromEnv ? (
          <Notice tone="info">
            GOOGLE_WORKSPACE_CUSTOMER_ID is set where the site runs.
          </Notice>
        ) : (
          <PasteField
            label="Customer ID"
            name="setup-customer-id"
            onSave={(value) => saved(saveWorkspace({ customerId: value }))}
            placeholder="C01ab2cd3"
            value={
              workspace.directory.customer === OWN_GOOGLE_CUSTOMER
                ? ""
                : workspace.directory.customer
            }
          />
        )}
      </CheckItem>

      <CheckItem
        ok={null}
        title="d. Let the service account read the directory"
      >
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Open{" "}
            <ExternalLink href={ADMIN_ROLES_URL}>
              Admin console, Account, Admin roles
            </ExternalLink>
            , choose <strong>Create new role</strong> and paste the name.
          </li>
          <li>
            Under Admin API privileges tick <strong>Users, Read</strong> and{" "}
            <strong>Groups, Read</strong>. Nothing else.
          </li>
          <li>
            Open the role, choose <strong>Assign service accounts</strong> and
            paste the service account.
          </li>
        </ol>
        <div className="grid gap-4">
          <CopyValue label="Role name" value={directoryRoleName(productName)} />
          {target.serviceAccountEmail ? (
            <CopyValue
              label="Service account"
              value={target.serviceAccountEmail}
            />
          ) : null}
        </div>
        <TestButton label="Test directory access" run={testDirectory} />
      </CheckItem>

      <CheckItem
        ok={drive.export.driveId ? true : null}
        optional
        title="e. Create the Shared Drive for executed copies"
      >
        <p>
          <ExternalLink href={SHARED_DRIVES_URL}>
            Open Shared drives
          </ExternalLink>
          , create one named as below, choose <strong>Manage members</strong>{" "}
          and add {serviceAccount} as <strong>Content manager</strong>. Then
          paste the drive&apos;s address or ID.
        </p>
        <div className="grid gap-4">
          <CopyValue
            label="Shared Drive name"
            value={executedDriveName(productName)}
          />
          {target.serviceAccountEmail ? (
            <CopyValue
              label="Member (Content manager)"
              value={target.serviceAccountEmail}
            />
          ) : null}
        </div>
        {drive.export.driveIdSource === "env" ? (
          <Notice tone="info">
            GOOGLE_DRIVE_EXPORT_DRIVE_ID is set where the site runs.
          </Notice>
        ) : (
          <PasteField
            label="Shared Drive address or ID"
            name="setup-drive-id"
            onSave={(value) => saved(saveDrive({ exportDriveId: value }))}
            placeholder="https://drive.google.com/drive/folders/0A..."
            value={drive.export.driveId ?? ""}
          />
        )}
        <TestButton label="Test the Shared Drive" run={testDrive} />
      </CheckItem>

      <CheckItem ok={null} title="f. Test everything">
        <p>
          The tests use this site&apos;s own service account, as it will when
          people use it. Google can take a few minutes to apply a new role or
          member. Suggestions from the directory and the administrator group are
          turned on in{" "}
          <Link
            className={linkClassName}
            href="/settings/integrations/google-directory"
          >
            Workspace directory
          </Link>
          .
        </p>
        <ActionRow>
          <TestButton label="Test directory access" run={testDirectory} />
          <TestButton label="Test the Shared Drive" run={testDrive} />
        </ActionRow>
      </CheckItem>

      <OptionalDriveStep project={project} />
    </SetupSteps>
  );
}

/** Google Workspace setup: Automatic or Manual. */
export function GoogleWorkspaceSetup(props: GoogleSetupProps) {
  const [mode, setMode] = useState<"automatic" | "manual">("automatic");

  return (
    <div className="space-y-5">
      <ModeChoice mode={mode} onChange={setMode} />
      {mode === "automatic" ? (
        <AutomaticSetup {...props} />
      ) : (
        <ManualSetup {...props} />
      )}
    </div>
  );
}
