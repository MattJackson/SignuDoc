"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { OffboardingSection } from "@/components/settings/workspace-offboarding-section";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type {
  WorkspaceAdminView,
  WorkspaceSettingView,
} from "@/lib/workspace/admin-view";
import type { WorkspaceSettingKey } from "@/lib/workspace/settings";
import type {
  WorkspaceCheck,
  WorkspaceCheckTarget,
} from "@/lib/workspace/types";

// The workspace part of Settings, for the administrator: which workspace
// provider the install uses (none by default; the directory can have its
// own), the site's identity with each, the directory that suggests signers
// and copy recipients, and a group whose members are administrators. Each part has a test that runs as the
// administrator. A value an environment variable sets is shown as fixed.
//
// Each part is its own small section, so more parts can be added below.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type Values = Record<WorkspaceSettingKey, string>;
type FieldErrors = Partial<Record<WorkspaceSettingKey, string>>;
type Feedback = { message: string; tone: "error" | "success" } | null;

type ViewResponse = {
  error?: string;
  fieldErrors?: FieldErrors;
  view?: WorkspaceAdminView;
} | null;

function valuesOf(view: WorkspaceAdminView): Values {
  const values = {} as Values;

  for (const [key, setting] of Object.entries(view.settings)) {
    values[key as WorkspaceSettingKey] = setting.value ?? "";
  }

  return values;
}

function fixedHelper(setting: WorkspaceSettingView): string {
  return `Set by ${setting.env} on the server.`;
}

export function WorkspacePanel() {
  const [view, setView] = useState<WorkspaceAdminView | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/workspace", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as ViewResponse;

        if (!response.ok || !payload?.view) {
          setFeedback({
            message: payload?.error ?? GENERIC_ERROR_MESSAGE,
            tone: "error",
          });
          return;
        }

        setView(payload.view);
        setValues(valuesOf(payload.view));
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
        }
      });

    return () => controller.abort();
  }, []);

  function change(key: WorkspaceSettingKey, value: string) {
    setFeedback(null);
    setErrors((current) => ({ ...current, [key]: undefined }));
    setValues((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!view || !values) {
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    // Only what the page may change: a value the environment sets is not
    // sent.
    const settings: Partial<Values> = {};

    for (const key of Object.keys(values) as WorkspaceSettingKey[]) {
      if (view.settings[key].source !== "env") {
        settings[key] = values[key];
      }
    }

    try {
      const response = await fetch("/api/admin/workspace", {
        body: JSON.stringify({ settings }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as ViewResponse;

      if (!response.ok || !payload?.view) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setErrors({});
      setView(payload.view);
      setValues(valuesOf(payload.view));
      setFeedback({ message: "Workspace settings saved.", tone: "success" });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  // The provider for the directory as chosen on the page, saved or not.
  const providerId =
    values?.["directory.provider"] || values?.["workspace.provider"] || null;
  const providerSaved = Boolean(view?.directoryProvider);

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="workspace"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Workspace
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Connect your organization&apos;s workspace to suggest colleagues as
            signers and copy recipients, to take administrators from a group,
            and to offboard people who leave. Nothing here is on until you
            choose a provider.
          </p>
        </div>

        {feedback ? (
          <p
            className={`notice ${
              feedback.tone === "success" ? "notice-success" : "notice-danger"
            }`}
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        ) : null}

        {view && values ? (
          <form className="space-y-8" noValidate onSubmit={save}>
            <ProviderSection
              disabled={isSaving}
              onChange={change}
              values={values}
              view={view}
            />

            {providerId ? (
              <DirectorySection
                disabled={isSaving}
                errors={errors}
                onChange={change}
                providerId={providerId}
                providerSaved={providerSaved}
                values={values}
                view={view}
              />
            ) : null}

            {providerId ? (
              <AdminGroupSection
                disabled={isSaving}
                error={errors["directory.adminGroup"]}
                onChange={(value) => change("directory.adminGroup", value)}
                providerSaved={providerSaved}
                value={values["directory.adminGroup"]}
                view={view}
              />
            ) : null}

            {providerId ? (
              <OffboardingSection
                disabled={isSaving}
                error={errors["directory.domains"]}
                onChange={change}
                providerSaved={providerSaved}
                values={values}
                view={view}
              />
            ) : null}

            <ShellButton loading={isSaving} type="submit">
              {isSaving ? "Saving..." : "Save workspace settings"}
            </ShellButton>
          </form>
        ) : null}
      </div>
    </section>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="space-y-4 border-t border-(--border) pt-8">
      <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-2xl text-sm leading-6 text-(--secondary)">{children}</p>
  );
}

/** A provider choice: the default one, or the one for a capability. */
function ProviderSelect({
  disabled,
  emptyLabel,
  label,
  onChange,
  setting,
  value,
  view,
}: {
  disabled: boolean;
  emptyLabel: string;
  label: string;
  onChange: (value: string) => void;
  setting: WorkspaceSettingView;
  value: string;
  view: WorkspaceAdminView;
}) {
  const fixed = setting.source === "env";

  return (
    <label className="grid gap-1.5">
      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
        {label}
      </span>
      <select
        className="field-input"
        disabled={disabled || fixed}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{emptyLabel}</option>
        {view.providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </select>
      {fixed ? (
        <span className="text-xs leading-5 text-(--tertiary)">
          {fixedHelper(setting)}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Which providers: one for everything, and optionally another for the
 * directory. Then the site's identity with each provider in use.
 */
function ProviderSection({
  disabled,
  onChange,
  values,
  view,
}: {
  disabled: boolean;
  onChange: (key: WorkspaceSettingKey, value: string) => void;
  values: Values;
  view: WorkspaceAdminView;
}) {
  return (
    <div className="space-y-4">
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <ProviderSelect
          disabled={disabled}
          emptyLabel="None"
          label="Workspace provider"
          onChange={(value) => onChange("workspace.provider", value)}
          setting={view.settings["workspace.provider"]}
          value={values["workspace.provider"]}
          view={view}
        />
        <ProviderSelect
          disabled={disabled}
          emptyLabel="Same as the workspace provider"
          label="Directory provider"
          onChange={(value) => onChange("directory.provider", value)}
          setting={view.settings["directory.provider"]}
          value={values["directory.provider"]}
          view={view}
        />
      </div>

      {view.identities.length > 0 ? (
        <div className="space-y-3">
          {view.identities.map((provider) => (
            <Prose key={provider.id}>
              <strong className="text-(--fg)">
                This site&apos;s identity with {provider.label}:
              </strong>{" "}
              {provider.identity.description}
            </Prose>
          ))}
          <CheckButton
            disabled={
              !view.identities.some((provider) => provider.identity.configured)
            }
            label="Test identity"
            target="identity"
          />
        </div>
      ) : null}
    </div>
  );
}

/** The directory: on or off, how it is read, and its test. */
function DirectorySection({
  disabled,
  errors,
  onChange,
  providerId,
  providerSaved,
  values,
  view,
}: {
  disabled: boolean;
  errors: FieldErrors;
  onChange: (key: WorkspaceSettingKey, value: string) => void;
  providerId: string;
  providerSaved: boolean;
  values: Values;
  view: WorkspaceAdminView;
}) {
  const enabled = view.settings["directory.enabled"];
  const enabledFixed = enabled.source === "env";

  return (
    <Section title="Directory">
      <Prose>
        When it is on, anyone sending a document sees people from the directory
        as they type a signer&apos;s or copy recipient&apos;s name or address.
        Outside recipients are still typed in full. The site only reads the
        directory.
      </Prose>
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5">
        <input
          checked={values["directory.enabled"] === "on"}
          className="mt-1 size-4 accent-(--accent)"
          disabled={disabled || enabledFixed}
          onChange={(event) =>
            onChange("directory.enabled", event.target.checked ? "on" : "")
          }
          type="checkbox"
        />
        <span className="space-y-1">
          <span className="block text-sm font-bold text-(--fg)">
            Suggest people from the directory
          </span>
          {enabledFixed ? (
            <span className="block text-xs leading-5 text-(--tertiary)">
              {fixedHelper(enabled)}
            </span>
          ) : null}
        </span>
      </label>

      {providerId === "google" ? (
        <GoogleDirectoryFields
          disabled={disabled}
          errors={errors}
          onChange={onChange}
          values={values}
          view={view}
        />
      ) : null}

      <CheckButton
        disabled={!providerSaved}
        target="directory"
        label="Test directory"
      />
    </Section>
  );
}

/** How Google's directory is read: as the service account, or delegated. */
function GoogleDirectoryFields({
  disabled,
  errors,
  onChange,
  values,
  view,
}: {
  disabled: boolean;
  errors: FieldErrors;
  onChange: (key: WorkspaceSettingKey, value: string) => void;
  values: Values;
  view: WorkspaceAdminView;
}) {
  const customer = view.settings["google.customerId"];
  const subject = view.settings["google.adminSubject"];

  return (
    <div className="space-y-4">
      <Prose>
        Turn on the Admin SDK API in the site&apos;s Google Cloud project. Then
        either give the site&apos;s service account a custom admin role with
        only Users, Read and Groups, Read (recommended), and enter your Customer
        ID from Admin console, Account settings; or grant it domain-wide
        delegation with the two read-only directory scopes and enter an
        administrator to read the directory as. See docs/workspace.md.
      </Prose>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell
          disabled={disabled || customer.source === "env"}
          error={errors["google.customerId"]}
          helper={
            customer.source === "env"
              ? fixedHelper(customer)
              : "Needed with the admin role (starts with C)."
          }
          label="Google customer ID"
          name="workspace-google-customer-id"
          onChange={(event) =>
            onChange("google.customerId", event.target.value)
          }
          placeholder="my_customer"
          readOnly={customer.source === "env"}
          value={values["google.customerId"]}
        />
        <FieldShell
          disabled={disabled || subject.source === "env"}
          error={errors["google.adminSubject"]}
          helper={
            subject.source === "env"
              ? fixedHelper(subject)
              : "Only with domain-wide delegation. Leave empty with the admin role."
          }
          ignorePasswordManagers
          label="Read the directory as"
          name="workspace-google-admin-subject"
          onChange={(event) =>
            onChange("google.adminSubject", event.target.value)
          }
          placeholder="admin@yourcompany.com"
          readOnly={subject.source === "env"}
          type="email"
          value={values["google.adminSubject"]}
        />
      </div>
    </div>
  );
}

/** The group whose members are administrators. */
function AdminGroupSection({
  disabled,
  error,
  onChange,
  providerSaved,
  value,
  view,
}: {
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
  providerSaved: boolean;
  value: string;
  view: WorkspaceAdminView;
}) {
  const setting = view.settings["directory.adminGroup"];
  const fixed = setting.source === "env";

  return (
    <Section title="Administrators from a group">
      <Prose>
        Members of this group become administrators here when they sign in with
        single sign-on, and administrators who leave it stop being one. The last
        administrator always stays, and each change is in the site audit trail.
        Password sign-ins change nothing, so a break-glass account keeps its
        role. It needs the directory to be on.
      </Prose>
      <div className="max-w-xl">
        <FieldShell
          disabled={disabled || fixed}
          error={error ?? view.adminGroupProblem ?? undefined}
          helper={
            fixed
              ? fixedHelper(setting)
              : "The group's email address. Empty turns this off."
          }
          ignorePasswordManagers
          label="Administrator group"
          name="workspace-admin-group"
          onChange={(event) => onChange(event.target.value)}
          placeholder="signudoc-admins@yourcompany.com"
          readOnly={fixed}
          type="email"
          value={value}
        />
      </div>
      <CheckButton
        disabled={!providerSaved || !setting.value}
        target="adminGroup"
        label="Test administrator group"
      />
    </Section>
  );
}

/** Runs one part's checks on the saved settings and shows the answers. */
function CheckButton({
  disabled,
  label,
  target,
}: {
  disabled: boolean;
  label: string;
  target: WorkspaceCheckTarget;
}) {
  const [checks, setChecks] = useState<WorkspaceCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function run() {
    setIsRunning(true);
    setError(null);
    setChecks(null);

    try {
      const response = await fetch("/api/admin/workspace", {
        body: JSON.stringify({ target }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        checks?: WorkspaceCheck[];
        error?: string;
      } | null;

      if (!response.ok || !payload?.checks) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setChecks(payload.checks);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <ShellButton
        className="w-fit"
        disabled={disabled}
        loading={isRunning}
        onClick={() => void run()}
        variant="secondary"
      >
        {isRunning ? "Testing..." : label}
      </ShellButton>
      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}
      {checks?.map((check) => (
        <p
          className={`notice ${check.ok ? "notice-success" : "notice-danger"}`}
          data-testid={`workspace-check-${check.id}`}
          key={check.id}
          role="status"
        >
          <strong>{check.name}:</strong> {check.message}
        </p>
      ))}
    </div>
  );
}
