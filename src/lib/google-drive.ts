import { z } from "zod";

import { getDb } from "./db/connection.ts";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsActor,
  type IntegrationSettingsUpdate,
} from "./integration-settings.ts";
import { CONVERTIBLE_MIME_TYPES } from "./integrations/google/convert.ts";
import {
  getGoogleCredentials,
  GOOGLE_SCOPES,
  type GoogleCredentials,
} from "./integrations/google/credentials.ts";
import {
  DRIVE_API_BASE_URL,
  DriveApiError,
  driveJson,
} from "./integrations/google/drive-api.ts";
import {
  DEFAULT_DRIVE_FOLDER_PATTERN,
  isLabelValueSource,
  LABEL_VALUE_SOURCE_NAMES,
  LABEL_VALUE_SOURCES,
  readDriveExportConfig,
  readDriveLabelConfig,
  readPickerConfig,
  renderDrivePath,
  validateFolderPattern,
  type DriveSettingSource,
  type LabelFieldMapping,
  type LabelValueSource,
} from "./integrations/google/drive-config.ts";
import {
  listDriveExports,
  requeueDriveExport,
  runDriveExportNow,
  type DriveExportListItem,
  type DriveExportStatus,
} from "./integrations/google/drive-export.ts";
import {
  fieldKind,
  listDriveLabels,
  type LabelFieldKind,
} from "./integrations/google/drive-labels.ts";
import {
  driveRedirectUri,
  readDriveOAuthClient,
} from "./integrations/google/drive-oauth.ts";
import { getDriveConnection } from "./integrations/google/drive-tokens.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { readEnv, resolveAuthUrl, type EnvSource } from "./utils/env.ts";

// The Google Drive part of Settings, Google Workspace, and its onboarding
// step: the Picker on the new-envelope page, Drive's "Open with", the copy
// of every executed envelope in a Shared Drive, and labels on those copies.
// Like the rest of the Workspace page, an environment variable wins over
// what is saved here, and is shown as fixed.

export const DRIVE_OPEN_PATH = "/api/google/drive/open";

/** What Drive's "Open with" should offer this app for. */
export const DRIVE_UI_INTEGRATION = {
  defaultExtensions: ["pdf"],
  defaultMimeTypes: ["application/pdf"],
  importFormats: ["application/pdf"],
  secondaryExtensions: ["docx", "doc", "odt", "rtf"],
  secondaryMimeTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.oasis.opendocument.text",
    "application/rtf",
  ],
} as const;

export type GoogleDriveView = {
  /** Google sign-in is set up with Google, so people can connect Drive. */
  available: boolean;
  callbackUri: string | null;
  export: {
    defaultPattern: string;
    driveId: string | null;
    driveIdSource: DriveSettingSource;
    folderPattern: string;
    folderPatternSource: DriveSettingSource;
    /** Where an envelope completed now would go, as an example. */
    preview: string;
  };
  labels: {
    fields: LabelFieldMapping;
    labelId: string | null;
    source: DriveSettingSource;
    /** What a label field can be filled with, for the form. */
    sources: { id: LabelValueSource; name: string }[];
    subject: string | null;
    subjectFromEnv: boolean;
  };
  openUrl: string | null;
  openWith: typeof DRIVE_UI_INTEGRATION;
  picker: {
    apiKey: string | null;
    apiKeySource: DriveSettingSource;
    appId: string | null;
    appIdSource: DriveSettingSource;
    ready: boolean;
  };
  serviceAccountEmail: string | null;
  siteUrl: string | null;
};

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

function safeCredentials(): GoogleCredentials | null {
  try {
    return getGoogleCredentials();
  } catch {
    return null;
  }
}

export async function getGoogleDriveView(
  env: EnvSource = process.env,
  stored?: IntegrationSettings,
): Promise<GoogleDriveView> {
  const values = stored ?? (await getIntegrationSettings(env));
  const picker = readPickerConfig(env, values);
  const exportConfig = readDriveExportConfig(env, values);
  const labels = readDriveLabelConfig(env, values);
  const url = siteUrl(env);
  const credentials = safeCredentials();
  const serviceAccountEmail = credentials
    ? await credentials.getServiceAccountEmail().catch(() => null)
    : null;

  return {
    available: readDriveOAuthClient(env, values) !== null,
    callbackUri: driveRedirectUri(env),
    export: {
      defaultPattern: DEFAULT_DRIVE_FOLDER_PATTERN,
      driveId: exportConfig.driveId,
      driveIdSource: exportConfig.driveIdSource,
      folderPattern: exportConfig.folderPattern,
      folderPatternSource: exportConfig.folderPatternSource,
      preview: `${renderDrivePath(exportConfig.folderPattern, {
        completedAt: Math.floor(Date.now() / 1000),
        envelopeId: "3f2a9c1e-0000-4000-8000-000000000000",
        senderEmail: "sender@example.com",
        title: "Services agreement",
      }).join("/")}.pdf`,
    },
    labels: {
      fields: labels.fields,
      labelId: labels.labelId,
      source: labels.source,
      sources: LABEL_VALUE_SOURCES.map((id) => ({
        id,
        name: LABEL_VALUE_SOURCE_NAMES[id],
      })),
      subject: labels.subject,
      subjectFromEnv: Boolean(readEnv(env, "GOOGLE_DRIVE_LABELS_SUBJECT")),
    },
    openUrl: url ? `${url}${DRIVE_OPEN_PATH}` : null,
    openWith: DRIVE_UI_INTEGRATION,
    picker,
    serviceAccountEmail,
    siteUrl: url,
  };
}

export class GoogleDriveSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("Check the highlighted fields.");
    this.name = "GoogleDriveSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

const settingsSchema = z.object({
  appId: optionalText(40),
  exportDriveId: optionalText(200),
  exportFolderPattern: optionalText(300),
  labelFields: z.record(z.string().max(100), z.string().max(40)).optional(),
  labelId: optionalText(200),
  labelsSubject: optionalText(320),
  pickerApiKey: optionalText(200),
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates and saves the Drive settings an administrator changed. */
export async function saveGoogleDriveSettings(
  rawInput: unknown,
  actor: IntegrationSettingsActor,
  env: EnvSource = process.env,
): Promise<GoogleDriveView> {
  const parsed = settingsSchema.safeParse(rawInput);

  if (!parsed.success) {
    throw new GoogleDriveSettingsError({ form: "Check what was entered." });
  }

  const input = parsed.data;
  const update: IntegrationSettingsUpdate = {};
  const errors: Record<string, string> = {};

  if (
    input.pickerApiKey !== undefined &&
    !readEnv(env, "GOOGLE_PICKER_API_KEY")
  ) {
    if (
      input.pickerApiKey &&
      !/^[A-Za-z0-9_-]{20,200}$/.test(input.pickerApiKey)
    ) {
      errors.pickerApiKey =
        "An API key is letters, digits, dashes and underscores, such as AIza...";
    } else {
      update["drive.pickerApiKey"] = input.pickerApiKey || null;
    }
  }

  if (input.appId !== undefined && !readEnv(env, "GOOGLE_DRIVE_APP_ID")) {
    if (input.appId && !/^\d{6,20}$/.test(input.appId)) {
      errors.appId = "The project number is digits only, such as 123456789012";
    } else {
      update["drive.appId"] = input.appId || null;
    }
  }

  if (
    input.exportDriveId !== undefined &&
    !readEnv(env, "GOOGLE_DRIVE_EXPORT_DRIVE_ID")
  ) {
    const driveId = extractDriveId(input.exportDriveId);

    if (input.exportDriveId && !driveId) {
      errors.exportDriveId =
        "Paste the Shared Drive's ID, or its address from the browser";
    } else {
      update["drive.exportDriveId"] = driveId;
    }
  }

  if (
    input.exportFolderPattern !== undefined &&
    !readEnv(env, "GOOGLE_DRIVE_EXPORT_FOLDER_PATTERN")
  ) {
    const problem = validateFolderPattern(input.exportFolderPattern);

    if (problem) {
      errors.exportFolderPattern = problem;
    } else {
      update["drive.exportFolderPattern"] =
        input.exportFolderPattern === DEFAULT_DRIVE_FOLDER_PATTERN
          ? null
          : input.exportFolderPattern || null;
    }
  }

  if (!readEnv(env, "GOOGLE_DRIVE_LABEL_ID")) {
    if (input.labelId !== undefined) {
      const labelId = input.labelId.replace(/^labels\//, "");

      if (labelId && !/^[A-Za-z0-9_-]{1,100}$/.test(labelId)) {
        errors.labelId = "Pick a label from the list, or paste its ID";
      } else {
        update["drive.labelId"] = labelId || null;

        if (!labelId) {
          update["drive.labelFields"] = null;
        }
      }
    }

    if (
      input.labelFields !== undefined &&
      update["drive.labelFields"] !== null
    ) {
      const mapping: LabelFieldMapping = {};

      for (const [fieldId, source] of Object.entries(input.labelFields)) {
        if (!source) {
          continue;
        }

        if (
          !/^[A-Za-z0-9_-]{1,100}$/.test(fieldId) ||
          !isLabelValueSource(source)
        ) {
          errors.labelFields = "Choose a value for each field from the list.";
          break;
        }

        mapping[fieldId] = source;
      }

      update["drive.labelFields"] =
        Object.keys(mapping).length > 0 ? JSON.stringify(mapping) : null;
    }
  }

  if (
    input.labelsSubject !== undefined &&
    !readEnv(env, "GOOGLE_DRIVE_LABELS_SUBJECT")
  ) {
    if (input.labelsSubject && !emailPattern.test(input.labelsSubject)) {
      errors.labelsSubject =
        "Enter a Workspace user's email address, or leave this empty";
    } else {
      update["drive.labelsSubject"] = input.labelsSubject.toLowerCase() || null;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new GoogleDriveSettingsError(errors);
  }

  const saved = await saveIntegrationSettings(update, actor, {
    area: "google_drive",
    env,
  });

  return getGoogleDriveView(env, saved);
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

export type DriveActionFailure = {
  message: string;
  ok: false;
  status: number | null;
};

function failure(error: unknown): DriveActionFailure {
  if (error instanceof DriveApiError) {
    return {
      message: describeDriveStatus(error.status, error.reason),
      ok: false,
      status: error.status,
    };
  }

  return {
    message:
      error instanceof Error
        ? error.message
        : "Google Drive could not be asked.",
    ok: false,
    status: null,
  };
}

/** What a status from Drive means, for the administrator. */
export function describeDriveStatus(
  status: number | null,
  reason: string | null = null,
): string {
  switch (status) {
    case null:
      return "Google Drive could not be reached.";
    case 401:
    case 403:
      return `Google did not allow it (${String(status)}${reason ? `, ${reason}` : ""}). Check that the Google Drive API (and, for labels, the Drive Labels API) is enabled in the project, and that the service account is a Content manager of the Shared Drive.`;
    case 404:
      return "Google did not find it (404). Check the ID, and that the service account is a member of the Shared Drive.";
    case 429:
      return "Google is limiting requests right now (429). Try again in a minute.";
    default:
      return `Google Drive answered with ${String(status)}${reason ? ` (${reason})` : ""}.`;
  }
}

function requireCredentials(): GoogleCredentials {
  const credentials = safeCredentials();

  if (!credentials) {
    throw new Error(
      "No Google credentials: run on Google Cloud, or set GOOGLE_SERVICE_ACCOUNT_KEY.",
    );
  }

  return credentials;
}

export type SharedDriveListResult =
  DriveActionFailure | { drives: { id: string; name: string }[]; ok: true };

/** The Shared Drives the service account is a member of. */
export async function listSharedDrives(): Promise<SharedDriveListResult> {
  try {
    const token = await requireCredentials().getAccessToken({
      scopes: [GOOGLE_SCOPES.drive],
    });
    const drives: { id: string; name: string }[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({
        fields: "drives(id,name),nextPageToken",
        pageSize: "100",
        ...(pageToken ? { pageToken } : {}),
      });
      const body = await driveJson<{
        drives?: { id: string; name: string }[];
        nextPageToken?: string;
      }>(
        fetch,
        token,
        "Listing Shared Drives",
        `${DRIVE_API_BASE_URL}/drives?${params.toString()}`,
      );

      drives.push(...(body.drives ?? []));

      if (!body.nextPageToken) {
        break;
      }

      pageToken = body.nextPageToken;
    }

    return { drives, ok: true };
  } catch (error) {
    return failure(error);
  }
}

export type SharedDriveTestResult =
  DriveActionFailure | { canAddChildren: boolean; name: string; ok: true };

/** Whether the service account can add files to the Shared Drive. */
export async function testSharedDrive(
  driveIdInput: string | null,
  env: EnvSource = process.env,
): Promise<SharedDriveTestResult> {
  const driveId = driveIdInput
    ? extractDriveId(driveIdInput)
    : readDriveExportConfig(env, await getIntegrationSettings(env)).driveId;

  if (!driveId) {
    return { message: "Choose a Shared Drive first.", ok: false, status: null };
  }

  try {
    const token = await requireCredentials().getAccessToken({
      scopes: [GOOGLE_SCOPES.drive],
    });
    const drive = await driveJson<{
      capabilities?: { canAddChildren?: boolean };
      name?: string;
    }>(
      fetch,
      token,
      "Reading the Shared Drive",
      `${DRIVE_API_BASE_URL}/drives/${encodeURIComponent(driveId)}?fields=name,capabilities(canAddChildren)`,
    );

    return {
      canAddChildren: drive.capabilities?.canAddChildren === true,
      name: drive.name ?? driveId,
      ok: true,
    };
  } catch (error) {
    return failure(error);
  }
}

export type LabelSummary = {
  fields: {
    choices: string[];
    id: string;
    kind: LabelFieldKind | null;
    name: string;
  }[];
  id: string;
  title: string;
};

export type LabelListResult =
  DriveActionFailure | { labels: LabelSummary[]; ok: true };

/** Published labels the service account (or the named user) may apply. */
export async function listLabelsForSettings(
  env: EnvSource = process.env,
): Promise<LabelListResult> {
  const config = readDriveLabelConfig(env, await getIntegrationSettings(env));

  try {
    const token = await requireCredentials().getAccessToken({
      scopes: [GOOGLE_SCOPES.driveLabelsReadonly],
      ...(config.subject ? { subject: config.subject } : {}),
    });
    const labels = await listDriveLabels(token);

    return {
      labels: labels.map((label) => ({
        fields: (label.fields ?? []).map((field) => ({
          choices: (field.selectionOptions?.choices ?? [])
            .map((choice) => choice.properties?.displayName ?? "")
            .filter(Boolean),
          id: field.id,
          kind: fieldKind(field),
          name: field.properties?.displayName ?? field.id,
        })),
        id: label.id,
        title: label.properties?.title ?? label.id,
      })),
      ok: true,
    };
  } catch (error) {
    return failure(error);
  }
}

export function listExportsForSettings(
  status?: DriveExportStatus,
): Promise<DriveExportListItem[]> {
  return listDriveExports(getDb(), { limit: 25, status });
}

export type RetryResult =
  | { message: string; ok: false }
  | { ok: true; status: DriveExportStatus | null };

/** Puts an export back in line, records it, and tries it at once. */
export async function retryExportForSettings(
  envelopeId: string,
  actor: IntegrationSettingsActor,
): Promise<RetryResult> {
  const database = getDb();
  const requeued = await requeueDriveExport(
    database,
    envelopeId,
    Math.floor(Date.now() / 1000),
  );

  if (!requeued) {
    return {
      message: "There is no Drive export for this envelope.",
      ok: false,
    };
  }

  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event: "drive_export_retried",
      ipAddress: actor.ipAddress ?? null,
      metadata: { envelopeId, title: requeued.title },
      userAgent: actor.userAgent ?? null,
    },
    database,
  );

  return {
    ok: true,
    status: await runDriveExportNow(envelopeId, { database }),
  };
}

export type DrivePickerState = {
  /** The Picker can be shown: Google sign-in, an API key and an app ID. */
  available: boolean;
  connected: boolean;
  googleEmail: string | null;
};

/** What the new-envelope page needs to offer "Choose from Google Drive". */
export async function getDrivePickerState(
  userId: string,
  env: EnvSource = process.env,
): Promise<DrivePickerState> {
  try {
    const stored = await getIntegrationSettings(env);
    const available =
      readDriveOAuthClient(env, stored) !== null &&
      readPickerConfig(env, stored).ready &&
      driveRedirectUri(env) !== null;

    if (!available) {
      return { available: false, connected: false, googleEmail: null };
    }

    const connection = await getDriveConnection(userId);

    return {
      available,
      connected: connection !== null,
      googleEmail: connection?.googleEmail ?? null,
    };
  } catch {
    return { available: false, connected: false, googleEmail: null };
  }
}

/** Every MIME type the Picker offers. */
export const PICKER_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  ...CONVERTIBLE_MIME_TYPES,
];
