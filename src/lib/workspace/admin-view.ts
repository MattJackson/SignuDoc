import type { EnvSource } from "../utils/env.ts";
import { normalizeGroupAddress, readAdminGroup } from "./directory-settings.ts";
import { parseDomainList } from "./offboarding.ts";
import {
  configuredWorkspaceProviders,
  findWorkspaceProvider,
  resolveCapabilityProvider,
  WORKSPACE_PROVIDERS,
} from "./registry.ts";
import {
  readWorkspaceSettings,
  resolveWorkspaceSetting,
  WORKSPACE_SETTINGS,
  type ResolvedWorkspaceSetting,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdate,
} from "./settings.ts";
import type { WorkspaceIdentity } from "./types.ts";

// What the workspace part of Settings shows and accepts: every workspace
// setting with where its value comes from (an environment variable wins,
// and the page shows it as fixed), the identity of each provider in use,
// and the checks of what the administrator typed before it is saved.

export type WorkspaceSettingView = ResolvedWorkspaceSetting & {
  /** The variable that fixes it when set. */
  env: string;
};

type ProviderRef = { id: string; label: string };

export type WorkspaceAdminView = {
  adminGroupProblem: string | null;
  /** The provider serving the directory, after the default is applied. */
  directoryProvider: ProviderRef | null;
  /** Each provider the settings name, with the site's identity there. */
  identities: Array<ProviderRef & { identity: WorkspaceIdentity }>;
  /** The installed providers, to choose from. */
  providers: ProviderRef[];
  settings: Record<WorkspaceSettingKey, WorkspaceSettingView>;
};

function ref(provider: ProviderRef): ProviderRef {
  return { id: provider.id, label: provider.label };
}

export async function getWorkspaceAdminView(
  env: EnvSource = process.env,
  stored?: WorkspaceSettings,
): Promise<WorkspaceAdminView> {
  // Read fresh, not from the short-lived cache, so the page never shows a
  // value that was just replaced.
  const values = stored ?? (await readWorkspaceSettings());
  const settings = {} as Record<WorkspaceSettingKey, WorkspaceSettingView>;

  for (const key of Object.keys(WORKSPACE_SETTINGS) as WorkspaceSettingKey[]) {
    settings[key] = {
      ...resolveWorkspaceSetting(key, values, env),
      env: WORKSPACE_SETTINGS[key].env,
    };
  }

  const directory = resolveCapabilityProvider("directory", values, env);

  return {
    adminGroupProblem: readAdminGroup(values, env).problem ?? null,
    directoryProvider: directory.provider ? ref(directory.provider) : null,
    identities: await Promise.all(
      configuredWorkspaceProviders(values, env).map(async (provider) => ({
        ...ref(provider),
        identity: await provider.setup({ env, settings: values }).identity(),
      })),
    ),
    providers: WORKSPACE_PROVIDERS.map(ref),
    settings,
  };
}

export class WorkspaceSettingsInputError extends Error {
  readonly fieldErrors: Partial<Record<WorkspaceSettingKey, string>>;

  constructor(
    fieldErrors: Partial<Record<WorkspaceSettingKey, string>>,
    message = "Check the highlighted fields.",
  ) {
    super(message);
    this.name = "WorkspaceSettingsInputError";
    this.fieldErrors = fieldErrors;
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function chooseProvider(value: string): { error: string } | { value: string } {
  const provider = findWorkspaceProvider(value);

  return provider
    ? { value: provider.id }
    : { error: "Choose a provider from the list." };
}

/**
 * Each setting's check: the value to store, or an error for the page. An
 * empty value clears the setting. A setting with no check here belongs to
 * another part's own section in Settings, which saves it.
 */
const VALIDATORS: Partial<
  Record<
    WorkspaceSettingKey,
    (value: string) => { error: string } | { value: string }
  >
> = {
  "directory.adminGroup": (value) => {
    const group = normalizeGroupAddress(value);

    return group
      ? { value: group }
      : {
          error:
            "Enter the group's email address, such as signudoc-admins@yourcompany.com",
        };
  },
  "directory.enabled": (value) =>
    value === "on" || value === "off"
      ? { value }
      : { error: "Choose on or off." },
  "directory.domains": (value) => {
    const domains = parseDomainList(value);

    return domains && domains.length > 0
      ? { value: domains.join(", ") }
      : { error: "Enter domains like yourcompany.com, separated by commas" };
  },
  "directory.offboarding": (value) =>
    value === "on" || value === "off"
      ? { value }
      : { error: "Choose on or off." },
  "google.adminSubject": (value) =>
    emailPattern.test(value)
      ? { value: value.toLowerCase() }
      : {
          error: "Enter an administrator's email address, or leave this empty",
        },
  "google.customerId": (value) =>
    /^[A-Za-z0-9_]{1,64}$/.test(value)
      ? { value }
      : { error: "A customer ID is letters and digits, such as C01ab2cd3" },
  // The Gmail and Drive add-on's values from Google, as
  // `gcloud workspace-add-ons get-authorization` shows them.
  "google.addonServiceAccount": (value) =>
    /^[a-z0-9][a-z0-9-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.iam\.gserviceaccount\.com$/.test(
      value.toLowerCase(),
    )
      ? { value: value.toLowerCase() }
      : {
          error:
            "Enter the service account's address, ending in .iam.gserviceaccount.com",
        },
  "google.addonClientId": (value) =>
    /^[0-9A-Za-z_.-]{6,200}$/.test(value)
      ? { value }
      : { error: "Enter the OAuth client ID that gcloud showed" },
  "addIn.provider": chooseProvider,
  "directory.provider": chooseProvider,
  "files.provider": chooseProvider,
  "workspace.provider": chooseProvider,
};

/**
 * The change to save from what the page sent: `{ settings: { key: value } }`
 * where a value is a string, or null or "" to clear it. Keys an environment
 * variable fixes are left out, as the stored value would not be the one in
 * use; unknown keys are refused.
 */
export function parseWorkspaceSettingsInput(
  raw: unknown,
  env: EnvSource = process.env,
): WorkspaceSettingsUpdate {
  const input =
    raw && typeof raw === "object" && "settings" in raw
      ? (raw as { settings: unknown }).settings
      : null;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceSettingsInputError({}, "Nothing to save.");
  }

  const update: WorkspaceSettingsUpdate = {};
  const errors: Partial<Record<WorkspaceSettingKey, string>> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(WORKSPACE_SETTINGS, key)) {
      throw new WorkspaceSettingsInputError({}, `Unknown setting: ${key}.`);
    }

    const settingKey = key as WorkspaceSettingKey;

    if (resolveWorkspaceSetting(settingKey, null, env).source === "env") {
      continue;
    }

    if (value !== null && typeof value !== "string") {
      errors[settingKey] = "Enter text.";
      continue;
    }

    const trimmed = value?.trim() ?? "";

    if (!trimmed) {
      update[settingKey] = null;
      continue;
    }

    if (trimmed.length > 320) {
      errors[settingKey] = "This is too long.";
      continue;
    }

    const validate = VALIDATORS[settingKey];

    if (!validate) {
      errors[settingKey] = "This setting is saved in its own section.";
      continue;
    }

    const checked = validate(trimmed);

    if ("error" in checked) {
      errors[settingKey] = checked.error;
    } else {
      update[settingKey] = checked.value;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new WorkspaceSettingsInputError(errors);
  }

  return update;
}
