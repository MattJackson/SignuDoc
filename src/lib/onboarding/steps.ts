import { readSsoConfig } from "../auth/sso.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
} from "../integration-settings.ts";
import { getGoogleCredentials } from "../integrations/google/credentials.ts";
import { readAddonConfig } from "../integrations/google/addon/config.ts";
import { readDirectoryConfig } from "../integrations/google/directory.ts";
import { resolveEmailDriver, resolveResendApiKey } from "../services/email.ts";
import { getSettings, type ResolvedSettings } from "../settings.ts";
import { describeStorageDriver } from "../storage-check.ts";
import { type EnvSource } from "../utils/env.ts";

// The steps of onboarding: what an administrator sets up after the first
// account is made, in order. Each step has a check that says how far along
// it is, from the settings themselves, so the checklist in Settings is
// always true to the install. A step can be skipped and come back to, and
// a step that has a sensible "leave it as it is" can be confirmed as done.
//
// Other parts of the app add a step by adding it here (and its form to
// components/onboarding/steps.tsx under the same id). A Google Drive step
// belongs after "google-directory" when Drive features arrive, before the
// add-on ("google-addon"), which ends the Google steps.

export type OnboardingStepId =
  | "organization"
  | "email"
  | "google-sign-in"
  | "google-directory"
  | "google-addon"
  | "storage"
  | "backups"
  | "retention";

export type OnboardingCheck = {
  /** One line on where the step stands. */
  detail: string;
  status: "done" | "needs_attention" | "not_started";
};

export type OnboardingStepStatus = OnboardingCheck["status"] | "skipped";

export type OnboardingContext = {
  env: EnvSource;
  /** Steps the administrator skipped or confirmed (onboarding.steps). */
  marks: OnboardingMarks;
  settings: ResolvedSettings;
  stored: IntegrationSettings;
};

export type OnboardingStep = {
  /** Where the same settings live in Settings, for later changes. */
  settingsHref: string;
  check(context: OnboardingContext): Promise<OnboardingCheck>;
  /** Whether "leave it as it is" can mark it done. */
  confirmable?: boolean;
  id: OnboardingStepId;
  summary: string;
  title: string;
};

export type OnboardingMark = "confirmed" | "skipped";

export type OnboardingMarks = Partial<Record<OnboardingStepId, OnboardingMark>>;

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    check: async ({ settings }) => {
      if (!settings.organizationName || !settings.supportAddress) {
        return {
          detail:
            "Name the organization and give signers an address for questions.",
          status: "not_started",
        };
      }

      if (settings.signupMode === "open") {
        return {
          detail: "Anyone who finds this site can create an account.",
          status: "needs_attention",
        };
      }

      return {
        detail:
          settings.signupMode === "domains"
            ? `Accounts at ${settings.allowedEmailDomains.join(", ")}.`
            : "Nobody new can create an account.",
        status: "done",
      };
    },
    id: "organization",
    settingsHref: "/settings#organization",
    summary:
      "Your organization's name, support address, and who can create an account.",
    title: "Organization",
  },
  {
    check: async ({ env, settings }) => {
      if (safeEmailDriver(env) === "capture") {
        return {
          detail: "Development: emails are saved to a folder, not sent.",
          status: "done",
        };
      }

      const key = await resolveResendApiKey(env).catch(() => null);

      if (!key) {
        return {
          detail: "No Resend API key yet, so nothing can be emailed.",
          status: "not_started",
        };
      }

      return settings.emailReadyAt !== null
        ? {
            detail: `Sending from ${settings.senderAddress ?? "Resend"}.`,
            status: "done",
          }
        : {
            detail:
              "Resend is connected; the sending domain is not verified yet.",
            status: "needs_attention",
          };
    },
    id: "email",
    settingsHref: "/settings#email-setup",
    summary:
      "Connect Resend, verify the sending domain, and send yourself a test email.",
    title: "Email",
  },
  {
    check: async ({ env, stored }) => {
      const sso = readSsoConfig(env, stored);

      if (!sso) {
        return {
          detail: "Only passwords so far.",
          status: "not_started",
        };
      }

      return sso.google
        ? { detail: "People sign in with Google.", status: "done" }
        : { detail: `People sign in with ${sso.name}.`, status: "done" };
    },
    id: "google-sign-in",
    settingsHref: "/settings#google-workspace",
    summary:
      "Let everyone in your Google Workspace sign in with Google, and turn passwords off.",
    title: "Google sign-in",
  },
  {
    check: async ({ env, stored }) => {
      const config = readDirectoryConfig(env, stored);

      if (!config.enabled) {
        return {
          detail:
            "Recipients are typed in full; no suggestions from the directory.",
          status: "not_started",
        };
      }

      let credentials;

      try {
        credentials = getGoogleCredentials();
      } catch {
        credentials = null;
      }

      return credentials
        ? {
            detail: "Recipients are suggested from the Workspace directory.",
            status: "done",
          }
        : {
            detail:
              "The directory is on, but this site has no Google credentials.",
            status: "needs_attention",
          };
    },
    id: "google-directory",
    settingsHref: "/settings#google-workspace",
    summary:
      "Suggest colleagues as recipients, and make a Google Group's members administrators.",
    title: "Workspace directory and admin group",
  },
  {
    check: async ({ env, stored }) => {
      const config = readAddonConfig(env, stored);

      if (config.ready) {
        return {
          detail: "SignuDoc is in the Gmail and Drive side panel.",
          status: "done",
        };
      }

      return config.serviceAccountEmail || config.oauthClientId
        ? {
            detail:
              "Paste both the add-on's service account and its OAuth client ID.",
            status: "needs_attention",
          }
        : {
            detail: "Optional: send for signature from Gmail and Drive.",
            status: "not_started",
          };
    },
    id: "google-addon",
    settingsHref: "/settings#google-workspace-addon",
    summary:
      "Send attachments and Drive files for signature from the Gmail and Drive side panel.",
    title: "Gmail and Drive add-on",
  },
  {
    check: async ({ env }) => {
      const { driver, problem } = describeStorageDriver(env);

      if (!driver) {
        return {
          detail: problem ?? "Unknown storage.",
          status: "needs_attention",
        };
      }

      return {
        detail: `Documents are kept in ${driver} storage.`,
        status: "done",
      };
    },
    id: "storage",
    settingsHref: "/settings",
    summary:
      "Where documents are kept. Chosen when the site is deployed; check it works.",
    title: "Storage",
  },
  {
    check: async ({ marks }) =>
      marks.backups === "confirmed"
        ? { detail: "Backups are taken care of.", status: "done" }
        : {
            detail:
              "Plan how this site's database and documents are backed up.",
            status: "not_started",
          },
    confirmable: true,
    id: "backups",
    settingsHref: "/settings",
    summary: "Make sure the database and the documents are backed up.",
    title: "Backups",
  },
  {
    check: async ({ marks, settings }) => {
      if (settings.retentionDays !== null) {
        return {
          detail: `Finished envelopes are deleted after ${String(settings.retentionDays)} days.`,
          status: "done",
        };
      }

      return marks.retention === "confirmed"
        ? {
            detail: "Finished envelopes are kept until someone deletes them.",
            status: "done",
          }
        : {
            detail: "Decide how long finished documents are kept.",
            status: "not_started",
          };
    },
    confirmable: true,
    id: "retention",
    settingsHref: "/settings#organization",
    summary: "How long finished documents are kept before they are deleted.",
    title: "Retention",
  },
];

function safeEmailDriver(env: EnvSource): string | null {
  try {
    return resolveEmailDriver(env);
  } catch {
    return null;
  }
}

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return ONBOARDING_STEPS.some((step) => step.id === value);
}

export function readOnboardingMarks(
  stored: IntegrationSettings,
): OnboardingMarks {
  const raw = stored["onboarding.steps"];

  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const marks: OnboardingMarks = {};

    if (typeof parsed === "object" && parsed !== null) {
      for (const [id, mark] of Object.entries(parsed)) {
        if (
          isOnboardingStepId(id) &&
          (mark === "confirmed" || mark === "skipped")
        ) {
          marks[id] = mark;
        }
      }
    }

    return marks;
  } catch {
    return {};
  }
}

export type OnboardingStepState = {
  detail: string;
  id: OnboardingStepId;
  settingsHref: string;
  status: OnboardingStepStatus;
  summary: string;
  title: string;
  confirmable: boolean;
};

/** Every step with where it stands now, in order. */
export async function getOnboardingState(
  env: EnvSource = process.env,
): Promise<OnboardingStepState[]> {
  const [settings, stored] = await Promise.all([
    getSettings(env),
    getIntegrationSettings(env),
  ]);
  const marks = readOnboardingMarks(stored);
  const context: OnboardingContext = { env, marks, settings, stored };

  return Promise.all(
    ONBOARDING_STEPS.map(async (step) => {
      let check: OnboardingCheck;

      try {
        check = await step.check(context);
      } catch {
        check = {
          detail: "This could not be checked just now.",
          status: "needs_attention",
        };
      }

      return {
        confirmable: step.confirmable ?? false,
        detail: check.detail,
        id: step.id,
        settingsHref: step.settingsHref,
        // Skipping only shows while the step is not done; doing the step
        // later counts whatever was clicked before.
        status:
          check.status !== "done" && marks[step.id] === "skipped"
            ? "skipped"
            : check.status,
        summary: step.summary,
        title: step.title,
      };
    }),
  );
}

/** Marks a step skipped or confirmed, or clears the mark (null). */
export async function markOnboardingStep(
  id: OnboardingStepId,
  mark: OnboardingMark | null,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<void> {
  const step = ONBOARDING_STEPS.find((item) => item.id === id);

  if (mark === "confirmed" && !step?.confirmable) {
    throw new Error(
      `The ${id} step is done by setting it up, not by confirming it.`,
    );
  }

  const marks = readOnboardingMarks(await getIntegrationSettings(env));

  if (mark === null) {
    delete marks[id];
  } else {
    marks[id] = mark;
  }

  await saveIntegrationSettings(
    {
      "onboarding.steps":
        Object.keys(marks).length > 0 ? JSON.stringify(marks) : null,
    },
    actor,
    { area: "onboarding", env },
  );
}
