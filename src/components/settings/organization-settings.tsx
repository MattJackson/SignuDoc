"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { BrandingPanel } from "@/components/settings/branding-panel";
import { EmailSetupPanel } from "@/components/settings/email-setup-panel";
import { Part11Panel } from "@/components/settings/part11-panel";
import { PeoplePanel } from "@/components/settings/people-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { SignerDataPanel } from "@/components/settings/signer-data-panel";
import type {
  OrganizationSettingsField,
  OrganizationSettingsView,
} from "@/lib/organization-settings";
import type { SignupMode } from "@/lib/signup-policy";

// The administrator's part of Settings: what the install is called, who can
// sign up, where email comes from, and whether email works yet.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type OrganizationSettingsProps = {
  initialSettings: OrganizationSettingsView;
};

type FormErrors = Partial<Record<OrganizationSettingsField, string>>;

type Feedback = {
  message: string;
  tone: "error" | "success";
} | null;

type SettingsResponse = {
  error?: string;
  fieldErrors?: FormErrors;
  settings?: OrganizationSettingsView;
} | null;

const signupModeOptions: Array<{
  description: string;
  label: string;
  value: SignupMode;
}> = [
  {
    description:
      "Only people whose email address is at one of your domains can create an account.",
    label: "People at my organization",
    value: "domains",
  },
  {
    description: "Nobody new can create an account.",
    label: "Nobody",
    value: "closed",
  },
  {
    description: "Anyone who finds this site can create an account.",
    label: "Anyone",
    value: "open",
  },
];

export function OrganizationSettings({
  initialSettings,
}: OrganizationSettingsProps) {
  const router = useRouter();
  const [values, setValues] = useState(initialSettings);
  const [errors, setErrors] = useState<FormErrors>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Bumped after a save, so the email panel looks again: a new sender
  // address means a different domain to check.
  const [emailRevision, setEmailRevision] = useState(0);

  function handleChange(field: OrganizationSettingsField) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({ ...currentValues, [field]: nextValue }));
      setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
      setFeedback(null);
    };
  }

  function handleBrandColorChange(brandColor: string) {
    setValues((currentValues) => ({ ...currentValues, brandColor }));
    setErrors((currentErrors) => ({ ...currentErrors, brandColor: undefined }));
    setFeedback(null);
  }

  function handleSignupModeChange(signupMode: SignupMode) {
    setValues((currentValues) => ({ ...currentValues, signupMode }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      allowedEmailDomains: undefined,
      signupMode: undefined,
    }));
    setFeedback(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    setErrors({});
    setFeedback(null);
    setIsSaving(true);

    try {
      const response = await fetch("/api/admin/settings", {
        body: JSON.stringify({
          allowedEmailDomains: values.allowedEmailDomains,
          brandColor: values.brandColor,
          organizationName: values.organizationName,
          privacyUrl: values.privacyUrl,
          retentionDays: values.retentionDays,
          senderAddress: values.senderAddress,
          signupMode: values.signupMode,
          supportAddress: values.supportAddress,
          termsUrl: values.termsUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SettingsResponse;

      if (!response.ok || !payload?.settings) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setValues(payload.settings);
      setEmailRevision((revision) => revision + 1);
      setFeedback({ message: "Organization settings saved.", tone: "success" });
      // The header and the accent color come from the layout around this
      // page, which only looks them up again when asked to.
      router.refresh();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="organization"
    >
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Organization
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            These settings apply to everyone who uses this site. Only you, the
            administrator, can see and change them.
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

        <form className="space-y-8" noValidate onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={isSaving}
              error={errors.organizationName}
              helper="Shown in the header and in every email this site sends."
              label="Organization name"
              name="organization-name"
              onChange={handleChange("organizationName")}
              readOnly={false}
              value={values.organizationName}
            />
          </div>

          {/* The hosted service runs under its own name, mark and color. */}
          {!values.hosted ? (
            <BrandingPanel
              brandColor={values.brandColor}
              brandColorError={errors.brandColor}
              disabled={isSaving}
              logoUrl={values.logoUrl}
              onBrandColorChange={handleBrandColorChange}
              onLogoChange={(logoUrl) =>
                setValues((currentValues) => ({ ...currentValues, logoUrl }))
              }
            />
          ) : null}

          <fieldset className="space-y-4 border-t border-(--border) pt-8">
            <legend className="float-left mb-4 w-full text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Who can create an account
            </legend>
            <p className="clear-both max-w-2xl text-sm leading-6 text-(--secondary)">
              This is about people who send documents. People who are sent a
              document to sign never need an account.
            </p>
            <div className="space-y-3">
              {signupModeOptions.map((option) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
                  key={option.value}
                >
                  <input
                    checked={values.signupMode === option.value}
                    className="mt-1 size-4 accent-(--accent)"
                    disabled={isSaving}
                    name="signup-mode"
                    onChange={() => handleSignupModeChange(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-bold text-(--fg)">
                      {option.label}
                    </span>
                    <span className="block text-sm leading-6 text-(--secondary)">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {values.signupMode === "domains" || errors.allowedEmailDomains ? (
              <div className="max-w-xl">
                <FieldShell
                  disabled={isSaving}
                  error={errors.allowedEmailDomains}
                  helper="Separate several domains with commas."
                  label="Email domains"
                  name="allowed-email-domains"
                  onChange={handleChange("allowedEmailDomains")}
                  placeholder="yourcompany.com"
                  readOnly={false}
                  value={values.allowedEmailDomains}
                />
              </div>
            ) : null}
          </fieldset>

          <div className="space-y-5 border-t border-(--border) pt-8">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Email addresses
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell
                disabled={isSaving || values.senderAddressFromEnv}
                error={errors.senderAddress}
                helper={
                  values.senderAddressFromEnv
                    ? "Set by the RESEND_FROM_EMAIL environment variable."
                    : "The address emails come from, at a domain you own. A subdomain such as notifications@sign.yourcompany.com keeps this site's mail apart from your everyday email."
                }
                label="Send email from"
                name="sender-address"
                onChange={handleChange("senderAddress")}
                placeholder="sign@yourcompany.com"
                readOnly={values.senderAddressFromEnv}
                type="email"
                value={values.senderAddress}
              />
              <FieldShell
                disabled={isSaving || values.supportAddressFromEnv}
                error={errors.supportAddress}
                helper={
                  values.supportAddressFromEnv
                    ? "Set by the SUPPORT_EMAIL environment variable."
                    : "Where replies and questions from signers go."
                }
                label="Support address"
                name="support-address"
                onChange={handleChange("supportAddress")}
                placeholder="help@yourcompany.com"
                readOnly={values.supportAddressFromEnv}
                type="email"
                value={values.supportAddress}
              />
            </div>
          </div>

          {!values.hosted ? (
            <div className="space-y-5 border-t border-(--border) pt-8">
              <div className="space-y-2">
                <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                  Your terms and privacy policy
                </h3>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  Optional. Links to pages on your own website, shown in the
                  footer of this site and of its emails.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell
                  disabled={isSaving}
                  error={errors.termsUrl}
                  label="Terms link"
                  name="terms-url"
                  onChange={handleChange("termsUrl")}
                  placeholder="https://yourcompany.com/terms"
                  readOnly={false}
                  value={values.termsUrl}
                />
                <FieldShell
                  disabled={isSaving}
                  error={errors.privacyUrl}
                  label="Privacy policy link"
                  name="privacy-url"
                  onChange={handleChange("privacyUrl")}
                  placeholder="https://yourcompany.com/privacy"
                  readOnly={false}
                  value={values.privacyUrl}
                />
              </div>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Without a privacy policy link, signers see{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
                  href="/signer-privacy"
                  target="_blank"
                >
                  a notice built from these settings
                </a>
                . Check that it is right for your organization.
              </p>
            </div>
          ) : null}

          <div className="space-y-5 border-t border-(--border) pt-8">
            <div className="space-y-2">
              <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                How long to keep finished documents
              </h3>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Optional. After this many days a completed, declined or voided
                envelope is deleted with its audit trail. Its sender is emailed
                30 days before. Leave empty to keep them until someone deletes
                them. Many records must be kept for years, so check what applies
                to you before setting this.
              </p>
            </div>
            <div className="max-w-xs">
              <FieldShell
                disabled={isSaving || values.part11Mode}
                error={errors.retentionDays}
                helper={
                  values.part11Mode
                    ? "Off while Part 11 mode is on: those records are deleted by hand only."
                    : undefined
                }
                label="Days to keep"
                name="retention-days"
                onChange={handleChange("retentionDays")}
                placeholder="Keep until deleted"
                readOnly={false}
                value={values.retentionDays}
              />
            </div>
          </div>

          <ShellButton className="w-fit" loading={isSaving} type="submit">
            {isSaving ? "Saving..." : "Save organization settings"}
          </ShellButton>
        </form>

        <EmailSetupPanel key={emailRevision} />

        {/* The hosted service's accounts are strangers to each other, not
            one organization, so it has no list of them here. */}
        {!values.hosted ? <PeoplePanel part11Mode={values.part11Mode} /> : null}

        {!values.hosted ? (
          <SecurityPanel
            initialRequireTwoFactor={values.requireTwoFactor}
            initialSessionIdleMinutes={values.sessionIdleMinutes}
            initialSessionMaxHours={values.sessionMaxHours}
          />
        ) : null}

        {!values.hosted ? (
          <Part11Panel initialEnabled={values.part11Mode} />
        ) : null}

        <SignerDataPanel />
      </div>
    </section>
  );
}
