import type { BrandId, ConnectionStatus } from "./integration-kit";

// Every service SignuDoc connects to, as Settings and onboarding name it:
// its mark, its name and one line about what it does here. The Integrations
// overview lists them in these groups, each opening its own page.

export type IntegrationId =
  | "email"
  | "google-addon"
  | "google-directory"
  | "google-drive"
  | "google-sign-in"
  | "slack"
  | "storage";

export type IntegrationInfo = {
  brand: BrandId;
  description: string;
  group: "Email and messaging" | "Google Workspace" | "Storage";
  href: string;
  id: IntegrationId;
  name: string;
  /** The onboarding step that sets it up, for its status. */
  step: string;
};

export const INTEGRATIONS: readonly IntegrationInfo[] = [
  {
    brand: "google",
    description:
      "Everyone in your Google Workspace signs in with their Google account.",
    group: "Google Workspace",
    href: "/settings/integrations/google-sign-in",
    id: "google-sign-in",
    name: "Google sign-in",
    step: "google-sign-in",
  },
  {
    brand: "google",
    description:
      "Suggest colleagues as recipients, and make a Google Group's members administrators.",
    group: "Google Workspace",
    href: "/settings/integrations/google-directory",
    id: "google-directory",
    name: "Workspace directory",
    step: "google-directory",
  },
  {
    brand: "google-drive",
    description:
      "Start envelopes from Drive files, and keep executed copies in a Shared Drive.",
    group: "Google Workspace",
    href: "/settings/integrations/google-drive",
    id: "google-drive",
    name: "Google Drive",
    step: "google-drive",
  },
  {
    brand: "gmail",
    description:
      "Send attachments and Drive files for signature from the Gmail and Drive side panel.",
    group: "Google Workspace",
    href: "/settings/integrations/google-addon",
    id: "google-addon",
    name: "Gmail and Drive add-on",
    step: "google-addon",
  },
  {
    brand: "resend",
    description:
      "Signing invitations, reminders and finished documents are emailed through Resend.",
    group: "Email and messaging",
    href: "/settings/integrations/email",
    id: "email",
    name: "Email",
    step: "email",
  },
  {
    brand: "slack",
    description:
      "Tell senders and channels when envelopes are signed, completed or stuck.",
    group: "Email and messaging",
    href: "/settings/notifications",
    id: "slack",
    name: "Slack",
    step: "notifications",
  },
  {
    brand: "local-disk",
    description:
      "Where documents are kept. Chosen when the site is deployed, and checked here.",
    group: "Storage",
    href: "/settings/integrations/storage",
    id: "storage",
    name: "Document storage",
    step: "storage",
  },
];

/** The mark and name of the storage a deployment uses. */
export function describeStorageBrand(driver: string | null): {
  brand: BrandId;
  name: string;
} {
  switch (driver) {
    case "gcs":
      return { brand: "google-cloud", name: "Google Cloud Storage" };
    case "blob":
      return { brand: "vercel", name: "Vercel Blob" };
    default:
      return { brand: "local-disk", name: "Local disk" };
  }
}

/** The onboarding checklist's status, as an integration's. */
export function toConnectionStatus(
  status: "done" | "needs_attention" | "not_started" | "skipped",
): ConnectionStatus {
  return status === "done"
    ? "connected"
    : status === "needs_attention"
      ? "needs_attention"
      : "not_set_up";
}

/** The integration an onboarding step sets up, if it is one. */
export function integrationForStep(stepId: string): IntegrationInfo | null {
  return (
    INTEGRATIONS.find((integration) => integration.step === stepId) ?? null
  );
}
