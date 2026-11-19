import { z } from "zod";

import { getDb } from "../db/connection.ts";
import type { EnvSource } from "../utils/env.ts";
import {
  DEFAULT_EXPORT_FOLDER_PATTERN,
  listWorkspaceExports,
  previewExportPath,
  validateFolderPattern,
  type WorkspaceExportListItem,
} from "./exports.ts";
import { filesRedirectUri } from "./files.ts";
import {
  readWorkspaceSettings,
  resolveWorkspaceSetting,
  saveWorkspaceSettings,
  type ResolvedWorkspaceSetting,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
  type WorkspaceSettingsActor,
  type WorkspaceSettingsUpdate,
} from "./settings.ts";
import {
  EXPORT_METADATA_KEYS,
  EXPORT_METADATA_NAMES,
  isExportMetadataKey,
  type ExportMetadataKey,
  type WorkspaceCheck,
  type WorkspaceFiles,
} from "./types.ts";
import {
  getWorkspaceContext,
  getWorkspaceFiles,
  resolveCapabilityProvider,
} from "./registry.ts";

// Settings, "Shared folder for completed envelopes": where executed copies
// go and in which folders, the provider's own options for it (for Google,
// the Picker and a Drive label), the checks, and the copies that failed.
// An environment variable wins over what is saved, and is shown as fixed.

type Setting = ResolvedWorkspaceSetting;

export type WorkspaceFilesSettingsView = {
  callbackUri: string | null;
  destination: Setting;
  exports: WorkspaceExportListItem[];
  /** "Google Drive". */
  filesName: string;
  folderPattern: Setting & { defaultValue: string; preview: string };
  /** Options only Google has; null for another provider. */
  google: {
    driveLabelFields: Setting & {
      mapping: Partial<Record<string, ExportMetadataKey>>;
    };
    driveLabelId: Setting;
    pickerApiKey: Setting;
    pickerAppId: Setting;
  } | null;
  metadataKeys: Array<{ id: ExportMetadataKey; name: string }>;
  providerName: string;
};

function parseMapping(
  value: string | null,
): Partial<Record<string, ExportMetadataKey>> {
  if (!value) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const mapping: Partial<Record<string, ExportMetadataKey>> = {};

    if (typeof parsed === "object" && parsed && !Array.isArray(parsed)) {
      for (const [field, key] of Object.entries(parsed)) {
        if (isExportMetadataKey(key)) {
          mapping[field] = key;
        }
      }
    }

    return mapping;
  } catch {
    return {};
  }
}

/** The provider chosen for files, for the page: its id and name. */
export type FilesProviderChoice = { id: string; label: string };

/**
 * The provider chosen for files, and its files when they are set up, or
 * null when no provider is chosen for files.
 */
export async function getFilesProviderChoice(
  env: EnvSource = process.env,
): Promise<{
  choice: FilesProviderChoice;
  files: WorkspaceFiles | null;
} | null> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "files",
    context.settings,
    env,
  );

  return provider
    ? {
        choice: { id: provider.id, label: provider.label },
        files: provider.files?.(context) ?? null,
      }
    : null;
}

export async function getWorkspaceFilesSettingsView(
  provider: FilesProviderChoice,
  files: WorkspaceFiles | null,
  env: EnvSource = process.env,
  stored?: WorkspaceSettings,
): Promise<WorkspaceFilesSettingsView> {
  // Read fresh, not from the short-lived cache, so the form never shows a
  // value that was just replaced.
  const values = stored ?? (await readWorkspaceSettings());
  const read = (key: WorkspaceSettingKey) =>
    resolveWorkspaceSetting(key, values, env);
  const pattern = read("files.exportFolderPattern");
  const labelFields = read("google.driveLabelFields");

  return {
    callbackUri: filesRedirectUri(env),
    destination: read("files.exportDestination"),
    exports: await listWorkspaceExports(getDb(), { limit: 25 }),
    filesName: files?.name ?? provider.label,
    folderPattern: {
      ...pattern,
      defaultValue: DEFAULT_EXPORT_FOLDER_PATTERN,
      preview: previewExportPath(
        pattern.value ?? DEFAULT_EXPORT_FOLDER_PATTERN,
      ),
    },
    google:
      provider.id === "google"
        ? {
            driveLabelFields: {
              ...labelFields,
              mapping: parseMapping(labelFields.value),
            },
            driveLabelId: read("google.driveLabelId"),
            pickerApiKey: read("google.pickerApiKey"),
            pickerAppId: read("google.pickerAppId"),
          }
        : null,
    metadataKeys: EXPORT_METADATA_KEYS.map((id) => ({
      id,
      name: EXPORT_METADATA_NAMES[id],
    })),
    providerName: provider.label,
  };
}

export class WorkspaceFilesSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("Check the highlighted fields.");
    this.name = "WorkspaceFilesSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const workspaceFilesSettingsSchema = z.object({
  destination: optionalText(400),
  driveLabelFields: z
    .record(z.string().max(100), z.string().max(40))
    .optional(),
  driveLabelId: optionalText(200),
  folderPattern: optionalText(300),
  pickerApiKey: optionalText(200),
  pickerAppId: optionalText(40),
});

const FIELD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The change to save from what the administrator sent, or the problems
 * with it. A setting the environment fixes is left as it is.
 */
export function buildWorkspaceFilesUpdate(
  rawInput: unknown,
  /** The provider's own reading of a destination, once files are set up. */
  normalizeDestination: ((value: string) => string | null) | null,
  stored: WorkspaceSettings,
  env: EnvSource = process.env,
): WorkspaceSettingsUpdate {
  const parsed = workspaceFilesSettingsSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new WorkspaceFilesSettingsError({ form: "Check what was entered." });
  }

  const input = parsed.data;
  const update: WorkspaceSettingsUpdate = {};
  const errors: Record<string, string> = {};
  const fixed = (key: WorkspaceSettingKey) =>
    resolveWorkspaceSetting(key, stored, env).source === "env";

  if (input.destination !== undefined && !fixed("files.exportDestination")) {
    const destination = input.destination
      ? normalizeDestination
        ? normalizeDestination(input.destination)
        : plainDestinationId(input.destination)
      : null;

    if (input.destination && !destination) {
      errors.destination =
        "Paste the shared location's ID, or its address from the browser";
    } else {
      update["files.exportDestination"] = destination;
    }
  }

  if (
    input.folderPattern !== undefined &&
    !fixed("files.exportFolderPattern")
  ) {
    const problem = validateFolderPattern(input.folderPattern);

    if (problem) {
      errors.folderPattern = problem;
    } else {
      update["files.exportFolderPattern"] =
        input.folderPattern === DEFAULT_EXPORT_FOLDER_PATTERN
          ? null
          : input.folderPattern || null;
    }
  }

  if (input.pickerApiKey !== undefined && !fixed("google.pickerApiKey")) {
    if (
      input.pickerApiKey &&
      !/^[A-Za-z0-9_-]{20,200}$/.test(input.pickerApiKey)
    ) {
      errors.pickerApiKey =
        "An API key is letters, digits, dashes and underscores, such as AIza...";
    } else {
      update["google.pickerApiKey"] = input.pickerApiKey || null;
    }
  }

  if (input.pickerAppId !== undefined && !fixed("google.pickerAppId")) {
    if (input.pickerAppId && !/^\d{6,20}$/.test(input.pickerAppId)) {
      errors.pickerAppId =
        "The project number is digits only, such as 123456789012";
    } else {
      update["google.pickerAppId"] = input.pickerAppId || null;
    }
  }

  if (!fixed("google.driveLabelId")) {
    if (input.driveLabelId !== undefined) {
      const labelId = input.driveLabelId.replace(/^labels\//, "");

      if (labelId && !FIELD_ID_PATTERN.test(labelId)) {
        errors.driveLabelId = "Paste the label's ID, such as labels/abc123";
      } else {
        update["google.driveLabelId"] = labelId || null;

        if (!labelId) {
          update["google.driveLabelFields"] = null;
        }
      }
    }

    if (
      input.driveLabelFields !== undefined &&
      update["google.driveLabelFields"] !== null
    ) {
      const mapping: Record<string, ExportMetadataKey> = {};

      for (const [fieldId, source] of Object.entries(input.driveLabelFields)) {
        // A row with no value chosen is not a field to fill.
        if (!source) {
          continue;
        }

        if (!FIELD_ID_PATTERN.test(fieldId) || !isExportMetadataKey(source)) {
          errors.driveLabelFields =
            "Give each field's ID and choose its value from the list.";
          break;
        }

        mapping[fieldId] = source;
      }

      update["google.driveLabelFields"] =
        Object.keys(mapping).length > 0 ? JSON.stringify(mapping) : null;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new WorkspaceFilesSettingsError(errors);
  }

  return update;
}

/**
 * Before files are set up there is no provider to read an address, so
 * only a plain id is taken.
 */
function plainDestinationId(value: string): string | null {
  const trimmed = value.trim();

  return /^[A-Za-z0-9_-]{1,200}$/.test(trimmed) ? trimmed : null;
}

/** Validates and saves a change, and returns the view after it. */
export async function saveWorkspaceFilesSettings(
  rawInput: unknown,
  provider: FilesProviderChoice,
  files: WorkspaceFiles | null,
  actor: WorkspaceSettingsActor,
  env: EnvSource = process.env,
): Promise<WorkspaceFilesSettingsView> {
  const update = buildWorkspaceFilesUpdate(
    rawInput,
    files ? (value) => files.normalizeDestination(value) : null,
    await readWorkspaceSettings(),
    env,
  );

  await saveWorkspaceSettings(update, actor);

  // Built again: saving may have turned files on or off.
  return getWorkspaceFilesSettingsView(
    provider,
    await getWorkspaceFiles(env),
    env,
  );
}

/** The files checks of the provider chosen for files, for Settings. */
export async function checkWorkspaceFiles(
  env: EnvSource = process.env,
): Promise<WorkspaceCheck[]> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "files",
    context.settings,
    env,
  );

  return provider ? provider.setup(context).check("files") : [];
}
