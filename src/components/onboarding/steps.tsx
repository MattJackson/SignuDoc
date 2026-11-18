"use client";

import { useState, type ComponentType, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { EmailSetupPanel } from "@/components/settings/email-setup-panel";
import { GoogleAddonSection } from "@/components/settings/google-addon-panel";
import {
  GoogleDirectorySection,
  GoogleSignInSection,
  useGoogleWorkspace,
} from "@/components/settings/google-workspace-panel";
import type { GoogleAddonView } from "@/lib/google-addon";
import type { GoogleWorkspaceView } from "@/lib/google-workspace";
import type { OnboardingStepId } from "@/lib/onboarding/steps";
import type { OrganizationSettingsView } from "@/lib/organization-settings";

// The form for each onboarding step, by the step's id in
// lib/onboarding/steps.ts. A step added there gets its form here. Most
// reuse the panels from Settings, so a step and its place in Settings never
// drift apart.

export type OnboardingData = {
  googleAddon: GoogleAddonView;
  googleWorkspace: GoogleWorkspaceView;
  organization: OrganizationSettingsView;
  storage: { driver: string | null; problem: string | null };
};

export type StepFormProps = {
  data: OnboardingData;
  /** Called after the step saved something, so the checklist is read again. */
  onChanged: () => void;
};

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type Feedback = { message: string; tone: "error" | "success" } | null;

async function saveOrganization(
  view: OrganizationSettingsView,
  patch: Partial<OrganizationSettingsView>,
): Promise<{
  fieldErrors: Record<string, string>;
  message: string | null;
  settings: OrganizationSettingsView | null;
}> {
  const next = { ...view, ...patch };

  try {
    const response = await fetch("/api/admin/settings", {
      body: JSON.stringify({
        allowedEmailDomains: next.allowedEmailDomains,
        brandColor: next.brandColor,
        organizationName: next.organizationName,
        privacyUrl: next.privacyUrl,
        retentionDays: next.retentionDays,
        senderAddress: next.senderAddress,
        signupMode: next.signupMode,
        supportAddress: next.supportAddress,
        termsUrl: next.termsUrl,
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      fieldErrors?: Record<string, string>;
      settings?: OrganizationSettingsView;
    } | null;

    if (!response.ok || !payload?.settings) {
      return {
        fieldErrors: payload?.fieldErrors ?? {},
        message: payload?.error ?? GENERIC_ERROR_MESSAGE,
        settings: null,
      };
    }

    return { fieldErrors: {}, message: null, settings: payload.settings };
  } catch {
    return { fieldErrors: {}, message: GENERIC_ERROR_MESSAGE, settings: null };
  }
}

function Notice({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }

  return (
    <p
      className={`notice ${feedback.tone === "success" ? "notice-success" : "notice-danger"}`}
      role={feedback.tone === "error" ? "alert" : "status"}
    >
      {feedback.message}
    </p>
  );
}

function OrganizationStep({ data, onChanged }: StepFormProps) {
  const [view, setView] = useState(data.organization);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);

  function change(field: keyof OrganizationSettingsView) {
    return (event: { target: { value: string } }) => {
      setView((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: "" }));
      setFeedback(null);
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    const result = await saveOrganization(view, {});

    setSaving(false);
    setErrors(result.fieldErrors);

    if (result.settings) {
      setView(result.settings);
      setFeedback({ message: "Saved.", tone: "success" });
      onChanged();
    } else {
      setFeedback({
        message: result.message ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    }
  }

  return (
    <form className="space-y-6" noValidate onSubmit={submit}>
      <Notice feedback={feedback} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell
          disabled={saving}
          error={errors.organizationName}
          helper="Shown in the header and in every email this site sends."
          label="Organization name"
          name="organization-name"
          onChange={change("organizationName")}
          readOnly={false}
          value={view.organizationName}
        />
        <FieldShell
          disabled={saving || view.supportAddressFromEnv}
          error={errors.supportAddress}
          helper={
            view.supportAddressFromEnv
              ? "Set by the SUPPORT_EMAIL environment variable."
              : "Where replies and questions from signers go."
          }
          label="Support address"
          name="support-address"
          onChange={change("supportAddress")}
          readOnly={view.supportAddressFromEnv}
          type="email"
          value={view.supportAddress}
        />
        <FieldShell
          disabled={saving || view.senderAddressFromEnv}
          error={errors.senderAddress}
          helper={
            view.senderAddressFromEnv
              ? "Set by the RESEND_FROM_EMAIL environment variable."
              : "The address emails come from, at a domain you own, such as sign@yourcompany.com."
          }
          label="Send email from"
          name="sender-address"
          onChange={change("senderAddress")}
          readOnly={view.senderAddressFromEnv}
          type="email"
          value={view.senderAddress}
        />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-bold text-(--fg)">
          Who can create an account
        </legend>
        {(
          [
            [
              "domains",
              "People at my organization (recommended with Google Workspace)",
            ],
            ["closed", "Nobody new"],
            ["open", "Anyone"],
          ] as const
        ).map(([value, label]) => (
          <label
            className="flex items-center gap-3 text-sm text-(--fg)"
            key={value}
          >
            <input
              checked={view.signupMode === value}
              className="size-4 accent-(--accent)"
              disabled={saving}
              name="signup-mode"
              onChange={() =>
                setView((current) => ({ ...current, signupMode: value }))
              }
              type="radio"
            />
            {label}
          </label>
        ))}
        {view.signupMode === "domains" ? (
          <div className="max-w-xl">
            <FieldShell
              disabled={saving}
              error={errors.allowedEmailDomains}
              helper="Your Google Workspace domain. Separate several with commas."
              label="Email domains"
              name="allowed-email-domains"
              onChange={change("allowedEmailDomains")}
              placeholder="yourcompany.com"
              readOnly={false}
              value={view.allowedEmailDomains}
            />
          </div>
        ) : null}
      </fieldset>
      <ShellButton className="w-fit" loading={saving} type="submit">
        {saving ? "Saving..." : "Save"}
      </ShellButton>
    </form>
  );
}

function EmailStep({ onChanged }: StepFormProps) {
  return <EmailSetupPanel onStatusChange={() => onChanged()} />;
}

function GoogleSignInStep({ data }: StepFormProps) {
  const workspace = useGoogleWorkspace(data.googleWorkspace);

  return <GoogleSignInSection workspace={workspace} />;
}

function GoogleDirectoryStep({ data }: StepFormProps) {
  const workspace = useGoogleWorkspace(data.googleWorkspace);

  return <GoogleDirectorySection workspace={workspace} />;
}

function GoogleAddonStep({ data }: StepFormProps) {
  return <GoogleAddonSection initialView={data.googleAddon} />;
}

function StorageStep({ data }: StepFormProps) {
  const [result, setResult] = useState<Feedback>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    setResult(null);

    try {
      const response = await fetch("/api/admin/onboarding", {
        body: JSON.stringify({ action: "check_storage" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        storage?: { driver: string | null; message?: string; ok: boolean };
      } | null;

      setResult(
        payload?.storage?.ok
          ? {
              message: `A test file was written to ${payload.storage.driver ?? "storage"}, read back and deleted.`,
              tone: "success",
            }
          : {
              message:
                payload?.storage?.message ??
                payload?.error ??
                GENERIC_ERROR_MESSAGE,
              tone: "error",
            },
      );
    } catch {
      setResult({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4 text-sm leading-6 text-(--secondary)">
      <p>
        {data.storage.driver
          ? `Documents are kept in ${data.storage.driver} storage.`
          : `Storage is not set up: ${data.storage.problem ?? "unknown driver"}.`}{" "}
        Where documents are kept is chosen when the site is deployed (the
        STORAGE_DRIVER setting and its credentials), so it is shown here, not
        changed. See the self-hosting guide to move it.
      </p>
      <ShellButton loading={checking} onClick={() => void check()}>
        {checking ? "Checking..." : "Test read and write"}
      </ShellButton>
      <Notice feedback={result} />
    </div>
  );
}

function BackupsStep() {
  return (
    <div className="space-y-3 text-sm leading-6 text-(--secondary)">
      <p>
        Signed documents are records your organization may need for years. Back
        up both the database and the stored documents, and try a restore once.
      </p>
      <p>
        The backup and restore guide (docs/backup-and-restore.md) explains how.
        When backups are set up, choose &quot;Mark as done&quot; below.
      </p>
      <ShellButton href="/settings" variant="ghost">
        Open Settings
      </ShellButton>
    </div>
  );
}

function RetentionStep({ data, onChanged }: StepFormProps) {
  const [days, setDays] = useState(data.organization.retentionDays);
  const [error, setError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    const result = await saveOrganization(data.organization, {
      retentionDays: days,
    });

    setSaving(false);
    setError(result.fieldErrors.retentionDays);

    if (result.settings) {
      setFeedback({ message: "Saved.", tone: "success" });
      onChanged();
    } else {
      setFeedback({
        message: result.message ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    }
  }

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      <p className="text-sm leading-6 text-(--secondary)">
        After this many days a completed, declined or voided envelope is deleted
        with its audit trail; its sender is emailed 30 days before. Many records
        must be kept for years, so check what applies to you. To keep them until
        someone deletes them, leave this empty and choose &quot;Keep as it
        is&quot;.
      </p>
      <Notice feedback={feedback} />
      <div className="max-w-xs">
        <FieldShell
          disabled={saving || data.organization.part11Mode}
          error={error}
          helper={
            data.organization.part11Mode
              ? "Off while Part 11 mode is on: those records are deleted by hand only."
              : undefined
          }
          label="Days to keep"
          name="retention-days"
          onChange={(event) => setDays(event.target.value)}
          placeholder="Keep until deleted"
          readOnly={false}
          value={days}
        />
      </div>
      <ShellButton className="w-fit" loading={saving} type="submit">
        {saving ? "Saving..." : "Save"}
      </ShellButton>
    </form>
  );
}

export const STEP_FORMS: Record<
  OnboardingStepId,
  ComponentType<StepFormProps>
> = {
  backups: BackupsStep,
  email: EmailStep,
  "google-addon": GoogleAddonStep,
  "google-directory": GoogleDirectoryStep,
  "google-sign-in": GoogleSignInStep,
  organization: OrganizationStep,
  retention: RetentionStep,
  storage: StorageStep,
};
