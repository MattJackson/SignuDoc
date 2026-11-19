import { readEnv, type EnvSource } from "../../../../utils/env.ts";
import {
  resolveWorkspaceSetting,
  type WorkspaceSettings,
} from "../../../settings.ts";
import { isExportMetadataKey, type ExportMetadataKey } from "../../../types.ts";

// What the Google Drive parts are set to, from the workspace settings or the
// environment, which always wins (workspace/settings.ts).
//
// - Starting from Drive needs the OAuth client people connect with
//   (drive-oauth.ts), and for the Picker a browser API key and the Cloud
//   project's number (its "app ID"). Neither of these two is a secret: both
//   are sent to the browser, and the key should be restricted to this site
//   and the Picker API in the Cloud console.
// - A label on executed copies needs a Drive label and which envelope value
//   goes into each of its fields.
//
// Each part is off until it is given.

export type PickerConfig = {
  apiKey: string | null;
  appId: string | null;
  ready: boolean;
};

export function readPickerConfig(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): PickerConfig {
  const apiKey = resolveWorkspaceSetting("google.pickerApiKey", stored, env);
  const appId = resolveWorkspaceSetting("google.pickerAppId", stored, env);

  return {
    apiKey: apiKey.value,
    appId: appId.value,
    ready: Boolean(apiKey.value && appId.value),
  };
}

/** Label field id to the envelope value that goes in it. */
export type LabelFieldMapping = Record<string, ExportMetadataKey>;

export type DriveLabelConfig = {
  fields: LabelFieldMapping;
  labelId: string | null;
};

const FIELD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** A field mapping from JSON, keeping only known values. */
export function parseLabelFieldMapping(
  value: string | null | undefined,
): LabelFieldMapping {
  if (!value) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const mapping: LabelFieldMapping = {};

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      for (const [fieldId, source] of Object.entries(parsed)) {
        if (FIELD_ID_PATTERN.test(fieldId) && isExportMetadataKey(source)) {
          mapping[fieldId] = source;
        }
      }
    }

    return mapping;
  } catch {
    return {};
  }
}

export function readDriveLabelConfig(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): DriveLabelConfig {
  const labelId = resolveWorkspaceSetting("google.driveLabelId", stored, env);
  // The fields come from where the label does, so a label fixed by the
  // environment is not filled in from a mapping saved for another one.
  const fields =
    labelId.source === "env"
      ? readEnv(env, "GOOGLE_DRIVE_LABEL_FIELDS")
      : resolveWorkspaceSetting("google.driveLabelFields", stored, env).value;

  return {
    fields: parseLabelFieldMapping(fields),
    labelId: labelId.value?.replace(/^labels\//, "") || null,
  };
}

/** A Shared Drive's ID from the ID itself or its address in the browser. */
export function extractDriveId(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const fromUrl = /\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/.exec(
    trimmed,
  )?.[1];
  const candidate = fromUrl ?? trimmed;

  return /^[A-Za-z0-9_-]{10,100}$/.test(candidate) ? candidate : null;
}
