import { readEnv, type EnvSource } from "../../utils/env.ts";

// What the Google Drive features are set to, from Settings (stored in
// integration_settings) or the environment, which always wins.
//
// - The Picker on the new-envelope page needs a browser API key and the
//   Cloud project's number (its "app ID"). Neither is a secret: both are
//   sent to the browser, and the key should be restricted to this site and
//   the Picker API in the Cloud console.
// - The executed-copy export needs a Shared Drive, and optionally a folder
//   layout.
// - Labels on executed copies need a Drive label and which envelope value
//   goes into each of its fields.
//
// Every part is off until it is given.

export type StoredDriveSettings = Readonly<
  Partial<
    Record<
      | "drive.appId"
      | "drive.exportDriveId"
      | "drive.exportFolderPattern"
      | "drive.labelFields"
      | "drive.labelId"
      | "drive.labelsSubject"
      | "drive.pickerApiKey",
      string
    >
  >
>;

export type DriveSettingSource = "env" | "none" | "settings";

export const DEFAULT_DRIVE_FOLDER_PATTERN =
  "{yyyy}/{yyyy-MM-dd} — {title} — {shortId}";

export const LABEL_VALUE_SOURCES = [
  "title",
  "senderName",
  "senderEmail",
  "senderTeam",
  "completedDate",
  "counterparty",
  "counterpartyEmail",
  "envelopeId",
] as const;

export type LabelValueSource = (typeof LABEL_VALUE_SOURCES)[number];

export const LABEL_VALUE_SOURCE_NAMES: Record<LabelValueSource, string> = {
  completedDate: "Completed date",
  counterparty: "Counterparty (first outside signer's name)",
  counterpartyEmail: "Counterparty's email address",
  envelopeId: "Envelope ID",
  senderEmail: "Sender's email address",
  senderName: "Sender's name",
  senderTeam: "Sender's team",
  title: "Envelope title",
};

export function isLabelValueSource(value: unknown): value is LabelValueSource {
  return (
    typeof value === "string" &&
    (LABEL_VALUE_SOURCES as readonly string[]).includes(value)
  );
}

function pick(
  env: EnvSource,
  variable: string,
  stored: string | undefined,
): { source: DriveSettingSource; value: string | null } {
  const fromEnv = readEnv(env, variable);

  if (fromEnv) {
    return { source: "env", value: fromEnv };
  }

  const fromSettings = stored?.trim();

  return fromSettings
    ? { source: "settings", value: fromSettings }
    : { source: "none", value: null };
}

export type PickerConfig = {
  apiKey: string | null;
  apiKeySource: DriveSettingSource;
  appId: string | null;
  appIdSource: DriveSettingSource;
  ready: boolean;
};

export function readPickerConfig(
  env: EnvSource = process.env,
  stored: StoredDriveSettings | null = null,
): PickerConfig {
  const apiKey = pick(
    env,
    "GOOGLE_PICKER_API_KEY",
    stored?.["drive.pickerApiKey"],
  );
  const appId = pick(env, "GOOGLE_DRIVE_APP_ID", stored?.["drive.appId"]);

  return {
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    appId: appId.value,
    appIdSource: appId.source,
    ready: Boolean(apiKey.value && appId.value),
  };
}

export type DriveExportConfig = {
  driveId: string | null;
  driveIdSource: DriveSettingSource;
  enabled: boolean;
  folderPattern: string;
  folderPatternSource: DriveSettingSource;
};

export function readDriveExportConfig(
  env: EnvSource = process.env,
  stored: StoredDriveSettings | null = null,
): DriveExportConfig {
  const driveId = pick(
    env,
    "GOOGLE_DRIVE_EXPORT_DRIVE_ID",
    stored?.["drive.exportDriveId"],
  );
  const pattern = pick(
    env,
    "GOOGLE_DRIVE_EXPORT_FOLDER_PATTERN",
    stored?.["drive.exportFolderPattern"],
  );

  return {
    driveId: driveId.value,
    driveIdSource: driveId.source,
    enabled: driveId.value !== null,
    folderPattern: pattern.value ?? DEFAULT_DRIVE_FOLDER_PATTERN,
    folderPatternSource: pattern.source,
  };
}

export type LabelFieldMapping = Record<string, LabelValueSource>;

export type DriveLabelConfig = {
  fields: LabelFieldMapping;
  labelId: string | null;
  source: DriveSettingSource;
  /** A Workspace user to apply labels as, through domain-wide delegation. */
  subject: string | null;
};

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
        if (
          /^[A-Za-z0-9_-]{1,100}$/.test(fieldId) &&
          isLabelValueSource(source)
        ) {
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
  env: EnvSource = process.env,
  stored: StoredDriveSettings | null = null,
): DriveLabelConfig {
  const labelId = pick(env, "GOOGLE_DRIVE_LABEL_ID", stored?.["drive.labelId"]);
  const fromEnv = labelId.source === "env";
  const subject = pick(
    env,
    "GOOGLE_DRIVE_LABELS_SUBJECT",
    stored?.["drive.labelsSubject"],
  );

  return {
    fields: parseLabelFieldMapping(
      fromEnv
        ? readEnv(env, "GOOGLE_DRIVE_LABEL_FIELDS")
        : stored?.["drive.labelFields"],
    ),
    labelId: labelId.value?.replace(/^labels\//, "") ?? null,
    source: labelId.source,
    subject: subject.value,
  };
}

const MAX_SEGMENT_LENGTH = 200;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Where an executed copy goes in the Shared Drive: the folder names, then
 * the file's own name (without .pdf) last. Dates are in UTC. A slash in a
 * value (a title, say) does not make a folder; it becomes a dash.
 *
 * Tokens: {yyyy} {MM} {dd} {yyyy-MM} {yyyy-MM-dd} {title} {shortId}
 * {envelopeId} {senderEmail}. Anything else is kept as written.
 */
export function renderDrivePath(
  pattern: string,
  values: {
    completedAt: number;
    envelopeId: string;
    senderEmail?: string | null;
    title: string;
  },
): string[] {
  const date = new Date(values.completedAt * 1000);
  const yyyy = String(date.getUTCFullYear());
  const MM = twoDigits(date.getUTCMonth() + 1);
  const dd = twoDigits(date.getUTCDate());
  const clean = (value: string) => value.replace(/[/\\]+/g, "-").trim();
  const tokens: Record<string, string> = {
    MM,
    dd,
    envelopeId: values.envelopeId,
    senderEmail: clean(values.senderEmail ?? ""),
    shortId: values.envelopeId.replace(/-/g, "").slice(0, 8),
    title: clean(values.title),
    yyyy,
    "yyyy-MM": `${yyyy}-${MM}`,
    "yyyy-MM-dd": `${yyyy}-${MM}-${dd}`,
  };
  const segments = (pattern.trim() || DEFAULT_DRIVE_FOLDER_PATTERN)
    .split("/")
    .map((segment) =>
      segment
        .replace(/\{([A-Za-z-]+)\}/g, (whole, name: string) =>
          Object.hasOwn(tokens, name) ? (tokens[name] ?? "") : whole,
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_SEGMENT_LENGTH)
        .trim(),
    )
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

  return segments.length > 0
    ? segments
    : [clean(values.title) || values.envelopeId];
}

/** Whether a pattern is usable: not too long, and it names the file. */
export function validateFolderPattern(pattern: string): string | null {
  if (pattern.length > 300) {
    return "Keep the layout under 300 characters.";
  }

  if (pattern.trim().endsWith("/")) {
    return "The last part is the file's name, so the layout cannot end with a slash.";
  }

  return null;
}
