import { readSsoConfig } from "../auth/sso.ts";
import {
  getBackupSetupStatus,
  type BackupSetupStatus,
} from "../backup-config.ts";
import { getDb } from "../db/connection.ts";
import {
  resolveSealCertificate,
  resolveSealTimestamp,
} from "../seal-settings.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
} from "../integration-settings.ts";
import { getGoogleCredentials } from "../integrations/google/credentials.ts";
import { readAddonConfig } from "../integrations/google/addon/config.ts";
import { readDirectoryConfig } from "../integrations/google/directory.ts";
import { readDirectorySyncSetting } from "../directory-sync.ts";
import { readGoogleSigningSetting } from "../google-signing.ts";
import { readManagerPolicy } from "../manager-policy.ts";
import {
  readDriveExportConfig,
  readPickerConfig,
} from "../integrations/google/drive-config.ts";
import { describeNotificationSetup } from "../notifications/registry.ts";
import { resolveEmailDriver, resolveResendApiKey } from "../services/email.ts";
import { createStorageService } from "../services/storage.ts";
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
// components/onboarding/steps.tsx under the same id). The Google add-on
// ("google-addon") ends the Google steps.

export type OnboardingStepId =
  | "name"
  | "organization"
  | "email"
  | "google-sign-in"
  | "google-directory"
  | "people"
  | "google-drive"
  | "google-addon"
  | "storage"
  | "seal"
  | "backups"
  | "retention"
  | "notifications";

export type OnboardingCheck = {
  /** One line on where the step stands. */
  detail: string;
  status: "done" | "needs_attention" | "not_started";
};

export type OnboardingStepStatus = OnboardingCheck["status"] | "skipped";

export type OnboardingContext = {
  /**
   * Whether backups are set up and working. Read from the database when not
   * given; tests give it.
   */
  backupStatus?: () => Promise<BackupSetupStatus>;
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
    check: async ({ marks, settings }) => {
      if (settings.productName) {
        return { detail: `Called ${settings.productName}.`, status: "done" };
      }

      const fallback = settings.organizationName ?? "SignuDoc";

      return marks.name === "confirmed"
        ? { detail: `Goes by ${fallback}.`, status: "done" }
        : {
            detail: `Goes by ${fallback} until it has a name of its own.`,
            status: "not_started",
          };
    },
    confirmable: true,
    id: "name",
    settingsHref: "/settings/organization",
    summary:
      "What do you want to call this app? The name is used in the header, in emails, and for everything set up in Google and Slack.",
    title: "App name",
  },
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
    settingsHref: "/settings/organization",
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
    settingsHref: "/settings/integrations/email",
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
    settingsHref: "/settings/integrations/google-sign-in",
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
    settingsHref: "/settings/integrations/google-directory",
    summary:
      "Suggest colleagues as recipients, and make a Google Group's members administrators.",
    title: "Workspace directory and admin group",
  },
  {
    check: async ({ env, marks, stored }) => {
      const manager = readManagerPolicy(env, stored).mode;
      const google = readGoogleSigningSetting(env, stored).mode;
      const offboarding = readDirectorySyncSetting(env, stored).enabled;

      if (manager === "off" && google === "off" && !offboarding) {
        return marks.people === "confirmed"
          ? {
              detail: "No manager approval, Google signing or offboarding.",
              status: "done",
            }
          : {
              detail:
                "Choose whether managers approve first, employees sign with Google, and leavers are offboarded.",
              status: "not_started",
            };
      }

      return {
        detail: [
          manager === "off" ? null : `Manager approval: ${manager}.`,
          google === "off" ? null : `Employees sign with Google: ${google}.`,
          offboarding ? "Offboarding from the directory is on." : null,
        ]
          .filter(Boolean)
          .join(" "),
        status: "done",
      };
    },
    confirmable: true,
    id: "people",
    settingsHref: "/settings/managers",
    summary:
      "Have the sender's manager approve first, ask employees to sign with Google, and hand over a leaver's envelopes.",
    title: "Managers, employees and leavers",
  },
  {
    check: async ({ env, stored }) => {
      const picker = readPickerConfig(env, stored);
      const exportConfig = readDriveExportConfig(env, stored);

      if (!picker.ready && !exportConfig.enabled) {
        return {
          detail: "Documents are uploaded from this computer only.",
          status: "not_started",
        };
      }

      if (exportConfig.enabled) {
        let credentials;

        try {
          credentials = getGoogleCredentials();
        } catch {
          credentials = null;
        }

        if (!credentials) {
          return {
            detail:
              "Executed copies go to a Shared Drive, but this site has no Google credentials.",
            status: "needs_attention",
          };
        }
      }

      return {
        detail: [
          picker.ready ? "Envelopes can start from Google Drive." : null,
          exportConfig.enabled
            ? "Executed copies are kept in a Shared Drive."
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        status: "done",
      };
    },
    id: "google-drive",
    settingsHref: "/settings/integrations/google-drive",
    summary:
      "Start envelopes from Drive, open files with this site, and keep executed copies in a Shared Drive.",
    title: "Google Drive",
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
    settingsHref: "/settings/integrations/google-addon",
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

      // Only reads the configuration (nothing is written), so a driver that
      // is named but missing its bucket or token shows here, not at the
      // first upload.
      try {
        createStorageService({ env });
      } catch (error) {
        return {
          detail:
            error instanceof Error ? error.message : "Storage is not set up.",
          status: "needs_attention",
        };
      }

      return {
        detail: `Documents are kept in ${driver} storage.`,
        status: "done",
      };
    },
    id: "storage",
    settingsHref: "/settings/integrations/storage",
    summary:
      "Where documents are kept. Chosen when the site is deployed; check it works.",
    title: "Storage",
  },
  {
    check: async ({ env, marks, stored }) => checkSeal(env, stored, marks),
    confirmable: true,
    id: "seal",
    settingsHref: "/settings/documents",
    summary:
      "The trusted time on every seal, and the certificate finished documents are sealed with.",
    title: "Seal & timestamp",
  },
  {
    check: async ({ backupStatus, env, marks }) => {
      const status = await (backupStatus
        ? backupStatus()
        : getBackupSetupStatus(getDb(), env));

      if (status.state === "done") {
        return { detail: status.message, status: "done" };
      }

      if (status.state === "failing") {
        return { detail: status.message, status: "needs_attention" };
      }

      // Backed up some other way (the database's own backups and a bucket
      // the deployment copies): the administrator can say so.
      return marks.backups === "confirmed"
        ? {
            detail:
              "Backed up outside this app, as an administrator confirmed.",
            status: "done",
          }
        : { detail: status.message, status: "not_started" };
    },
    confirmable: true,
    id: "backups",
    settingsHref: "/settings/backups",
    summary:
      "A daily copy of the database and every document, kept apart from this install.",
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
    settingsHref: "/settings/organization",
    summary: "How long finished documents are kept before they are deleted.",
    title: "Retention",
  },
  {
    check: async ({ env, marks, stored }) => {
      const { configured } = describeNotificationSetup(env, stored);

      if (configured.length > 0) {
        return {
          detail: `Notifications go to ${configured.join(", ")}.`,
          status: "done",
        };
      }

      return marks.notifications === "confirmed"
        ? { detail: "No chat notifications; email only.", status: "done" }
        : {
            detail: "Nothing is sent to a chat tool yet.",
            status: "not_started",
          };
    },
    confirmable: true,
    id: "notifications",
    settingsHref: "/settings/notifications",
    summary:
      "Tell people in Slack when their envelopes are signed, completed or stuck.",
    title: "Notifications",
  },
];

/**
 * The seal step: done once the timestamp server and the certificate have
 * been chosen (here, in Settings or by the environment), or the
 * administrator kept what there is. A chosen certificate that cannot be
 * used needs attention whatever else is true.
 */
export function checkSeal(
  env: EnvSource,
  stored: IntegrationSettings,
  marks: OnboardingMarks,
  now: number = Date.now(),
): OnboardingCheck {
  const timestamp = resolveSealTimestamp(env, stored);
  const certificate = resolveSealCertificate(env, stored, now);

  if (certificate.kind === "install" && certificate.problem) {
    return { detail: certificate.problem, status: "needs_attention" };
  }

  const sealedWith =
    certificate.kind === "install"
      ? "the install's own certificate"
      : certificate.kind === "pkcs12"
        ? `the certificate of ${certificate.summary.subject}`
        : "the certificate in SEAL_P12_BASE64";
  const detail = timestamp.url
    ? `Sealed with ${sealedWith}, timestamped by ${hostOf(timestamp.url)}.`
    : `Sealed with ${sealedWith}, without a trusted time.`;
  // A new install has DigiCert's server stored by first-run setup, so it
  // starts done; an install from before has nothing stored.
  const chosen =
    timestamp.source !== "unset" ||
    certificate.kind !== "install" ||
    stored["seal.certificate"] !== undefined;

  if (chosen || marks.seal === "confirmed") {
    return { detail, status: "done" };
  }

  return {
    detail:
      "Seals have no trusted time yet. Turn on a timestamp server, or keep it as it is.",
    status: "not_started",
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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

  // Merged into what is stored while the settings are locked, so a mark
  // saved meanwhile on another instance is not written over.
  await saveIntegrationSettings(
    (before) => {
      const marks = readOnboardingMarks(before);

      if (mark === null) {
        delete marks[id];
      } else {
        marks[id] = mark;
      }

      return {
        "onboarding.steps":
          Object.keys(marks).length > 0 ? JSON.stringify(marks) : null,
      };
    },
    actor,
    { area: "onboarding", env },
  );
}
