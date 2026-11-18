"use client";

import { useState, type ComponentType, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { BackupSettingsSection } from "@/components/settings/backup-settings-section";
import { BrandingPanel } from "@/components/settings/branding-panel";
import { EmailSetupPanel } from "@/components/settings/email-setup-panel";
import { GoogleDriveSection } from "@/components/settings/google-drive-panel";
import { GoogleAddonSection } from "@/components/settings/google-addon-panel";
import {
  GoogleDirectorySection,
  GoogleSignInSection,
  useGoogleWorkspace,
} from "@/components/settings/google-workspace-panel";
import { SealSettingsSection } from "@/components/settings/seal-settings-section";
import { StorageCheckSection } from "@/components/settings/storage-panel";
import type { BackupSettingsView } from "@/lib/backup-config";
import type { GoogleDriveView } from "@/lib/google-drive";
import type { GoogleAddonView } from "@/lib/google-addon";
import { PeopleSettingsForm } from "@/components/settings/people-settings-panel";
import type { GoogleWorkspaceView } from "@/lib/google-workspace";
import type { OnboardingStepId } from "@/lib/onboarding/steps";
import type { OrganizationSettingsView } from "@/lib/organization-settings";
import type { SealSettingsView } from "@/lib/seal-setup";

// The form for each onboarding step, by the step's id in
// lib/onboarding/steps.ts. A step added there gets its form here. Most
// reuse the panels from Settings, so a step and its place in Settings never
// drift apart.

export type OnboardingData = {
  backups: BackupSettingsView;
  googleDrive: GoogleDriveView;
  googleAddon: GoogleAddonView;
  googleWorkspace: GoogleWorkspaceView;
  organization: OrganizationSettingsView;
  seal: SealSettingsView;
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

const NAME_EXAMPLES = ["SignuDoc", "BusbarSigner", "Acme Sign"];

function NameStep({ data, onChanged }: StepFormProps) {
  const [name, setName] = useState(data.organization.productName);
  const [error, setError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      const response = await fetch("/api/admin/settings", {
        body: JSON.stringify({ productName: name }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
      } | null;

      if (!response.ok) {
        setError(payload?.fieldErrors?.productName);
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setError(undefined);
      setFeedback({ message: "Saved.", tone: "success" });
      onChanged();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      <p className="text-sm leading-6 text-(--secondary)">
        Pick the name people will know this site by, such as{" "}
        {NAME_EXAMPLES.join(", ")}. The next steps suggest it for the Google
        consent screen, the OAuth client, the Picker key, the directory role,
        the Drive app and the Slack app, so you only type it once.
      </p>
      <Notice feedback={feedback} />
      <div className="max-w-md">
        <FieldShell
          disabled={saving}
          error={error}
          helper={`Up to 60 characters. Leave it empty to go by ${data.organization.organizationName || "the organization's name"}.`}
          label="What do you want to call this app?"
          name="product-name"
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
            setFeedback(null);
          }}
          placeholder={data.organization.organizationName || "SignuDoc"}
          readOnly={false}
          value={name}
        />
      </div>
      <ShellButton className="w-fit" loading={saving} type="submit">
        {saving ? "Saving..." : "Save"}
      </ShellButton>
    </form>
  );
}

function BrandingStep({ data, onChanged }: StepFormProps) {
  const [view, setView] = useState(data.organization);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);

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
      <div className="max-w-md">
        <FieldShell
          disabled={saving}
          error={errors.organizationName}
          helper="Shown to signers and in every email this site sends."
          label="Organization name"
          name="organization-name"
          onChange={(event) => {
            setView((current) => ({
              ...current,
              organizationName: event.target.value,
            }));
            setErrors((current) => ({ ...current, organizationName: "" }));
            setFeedback(null);
          }}
          readOnly={false}
          value={view.organizationName}
        />
      </div>
      <BrandingPanel
        brandColor={view.brandColor}
        brandColorError={errors.brandColor}
        disabled={saving}
        logoUrl={view.logoUrl}
        onBrandColorChange={(brandColor) => {
          setView((current) => ({ ...current, brandColor }));
          setErrors((current) => ({ ...current, brandColor: "" }));
          setFeedback(null);
        }}
        onLogoChange={(logoUrl) => {
          setView((current) => ({ ...current, logoUrl }));
          onChanged();
        }}
      />
      <ShellButton className="w-fit" loading={saving} type="submit">
        {saving ? "Saving..." : "Save name and color"}
      </ShellButton>
    </form>
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
        message: result.fieldErrors.organizationName
          ? "Name the organization first, in the Logo and organization step."
          : (result.message ?? GENERIC_ERROR_MESSAGE),
        tone: "error",
      });
    }
  }

  return (
    <form className="space-y-6" noValidate onSubmit={submit}>
      <Notice feedback={feedback} />
      <div className="grid gap-4 sm:grid-cols-2">
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
        <legend className="pb-1 text-sm font-bold text-(--fg)">
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
            className="flex cursor-pointer items-center gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 text-sm font-semibold text-(--fg) ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
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

function GoogleDriveStep({ data }: StepFormProps) {
  return <GoogleDriveSection initialView={data.googleDrive} />;
}

function GoogleAddonStep({ data }: StepFormProps) {
  return <GoogleAddonSection initialView={data.googleAddon} />;
}

function StorageStep({ data }: StepFormProps) {
  return <StorageCheckSection storage={data.storage} />;
}

function SealStep({ data, onChanged }: StepFormProps) {
  return <SealSettingsSection initialView={data.seal} onChange={onChanged} />;
}

function PeopleStep({ onChanged }: StepFormProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-(--secondary)">
        Each of these is optional and off until you turn it on. To leave them
        all off, choose &quot;Mark as done&quot;.
      </p>
      <PeopleSettingsForm onSaved={onChanged} />
    </div>
  );
}

function BackupsStep({ data, onChanged }: StepFormProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-(--secondary)">
        Signed documents are records your organization may need for years.
        Choose where the daily backup goes and run one now. If the database and
        documents are already backed up another way (see
        docs/backup-and-restore.md), choose &quot;Mark as done&quot; below
        instead.
      </p>
      <BackupSettingsSection initialView={data.backups} onChange={onChanged} />
    </div>
  );
}

function NotificationsStep() {
  return (
    <div className="space-y-3 text-sm leading-6 text-(--secondary)">
      <p>
        Slack can tell senders when their envelopes are signed, completed,
        declined or stuck, post a team&apos;s envelopes to its channel, and tell
        administrators when a backup fails. You create a small Slack app from a
        manifest this site writes for you and paste its token. Google Chat,
        Microsoft Teams and webhooks come later.
      </p>
      <p>
        Notifications are optional. To go without them, choose &quot;Mark as
        done&quot;.
      </p>
      <ShellButton href="/settings/notifications" variant="secondary">
        Set up notifications
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
  branding: BrandingStep,
  email: EmailStep,
  "google-addon": GoogleAddonStep,
  "google-directory": GoogleDirectoryStep,
  "google-drive": GoogleDriveStep,
  "google-sign-in": GoogleSignInStep,
  name: NameStep,
  notifications: NotificationsStep,
  organization: OrganizationStep,
  people: PeopleStep,
  retention: RetentionStep,
  seal: SealStep,
  storage: StorageStep,
};
