import type { EnvSource } from "../../../../utils/env.ts";
import {
  resolveWorkspaceSetting,
  type WorkspaceSettings,
} from "../../../settings.ts";
import {
  ExportError,
  FileImportError,
  FilesConnectionError,
  type WorkspaceFiles,
  type WorkspaceCheck,
} from "../../../types.ts";
import { exportGoogleFileToPdf, PICKER_MIME_TYPES } from "./convert.ts";
import {
  GOOGLE_SCOPES,
  googleCredentialsFor,
  type GoogleCredentials,
} from "../credentials.ts";
import {
  DRIVE_API_BASE_URL,
  DriveApiError,
  driveJson,
  type FetchLike,
} from "./drive-api.ts";
import {
  extractDriveId,
  readDriveLabelConfig,
  readPickerConfig,
} from "./drive-config.ts";
import { driveFileUrl, exportToSharedDrive } from "./drive-export.ts";
import { fieldKind, getDriveLabel } from "./drive-labels.ts";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  grantsDriveFile,
  readDriveOAuthClient,
  readIdTokenClaims,
  revokeToken,
} from "./drive-oauth.ts";
import { createDriveTokenStore, type DriveTokenStore } from "./drive-tokens.ts";

// Google Drive as the workspace's files (workspace/types.ts, WorkspaceFiles):
//
// - Starting an envelope from Drive: each person connects their own Drive
//   (drive-oauth.ts, drive-tokens.ts), picks a file in the Google Picker,
//   and the file is read with their token and made into a PDF
//   (convert.ts).
// - Executed copies: the site's service account puts them in a Shared
//   Drive and labels them (drive-export.ts).

/** Drive file IDs are letters, digits, dashes and underscores. */
export function isDriveFileId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

export type GoogleFilesOptions = {
  /** For tests; the site's credentials otherwise. */
  credentials?: () => GoogleCredentials | null;
  env: EnvSource;
  fetchImpl?: FetchLike;
  /** The stored workspace settings, read once for this provider. */
  stored: WorkspaceSettings | null;
  /** For tests; a store on the database otherwise. */
  tokens?: DriveTokenStore;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

export function createGoogleFiles({
  credentials: givenCredentials,
  env,
  fetchImpl = fetch,
  stored,
  tokens = createDriveTokenStore({ env, fetchImpl }),
}: GoogleFilesOptions): WorkspaceFiles & {
  check(): Promise<WorkspaceCheck[]>;
} {
  const client = readDriveOAuthClient(env);
  const picker = readPickerConfig(stored, env);
  const label = readDriveLabelConfig(stored, env);
  const credentials = givenCredentials ?? (() => googleCredentialsFor(env));

  function requireClient() {
    if (!client) {
      throw new FilesConnectionError(
        "not_configured",
        "Google Drive is not set up on this site.",
      );
    }

    return client;
  }

  async function serviceAccountToken(request: {
    scopes: readonly string[];
  }): Promise<string> {
    let found: GoogleCredentials | null;

    try {
      found = credentials();
    } catch (error) {
      throw new ExportError(errorMessage(error));
    }

    if (!found) {
      throw new ExportError(
        "This site has no Google identity, so it cannot reach the Shared Drive.",
      );
    }

    return found.getAccessToken(request);
  }

  async function finishConnect(input: {
    email: string;
    params: URLSearchParams;
    redirectUri: string;
    secret: string;
    userId: string;
  }) {
    const code = input.params.get("code");

    if (input.params.get("error") || !code) {
      throw new FilesConnectionError(
        "denied",
        "Access to Google Drive was not allowed.",
      );
    }

    const token = await exchangeAuthorizationCode({
      client: requireClient(),
      code,
      codeVerifier: input.secret,
      env,
      fetchImpl,
      redirectUri: input.redirectUri,
    });
    const account = readIdTokenClaims(token.idToken);
    const wrongAccount =
      !account || account.email !== input.email.trim().toLowerCase();

    if (
      !account ||
      wrongAccount ||
      !token.refreshToken ||
      !grantsDriveFile(token.scope)
    ) {
      // Not kept, so Google is asked to forget it straight away.
      await revokeToken(token.refreshToken ?? token.accessToken, {
        env,
        fetchImpl,
      });

      throw wrongAccount
        ? new FilesConnectionError(
            "wrong_account",
            "That Google account is not the one you sign in to this site with.",
          )
        : new FilesConnectionError(
            "denied",
            "Access to Google Drive was not allowed.",
          );
    }

    const replaced = await tokens.save({
      accountEmail: account.email,
      accountId: account.sub,
      refreshToken: token.refreshToken,
      scope: token.scope,
      userId: input.userId,
    });

    // Only when the person connected a different Google account: the old
    // token is then of no use. For the same account it belongs to the
    // grant the new token is part of, and revoking it would end the new
    // connection too.
    if (replaced && replaced.accountId !== account.sub) {
      await revokeToken(replaced.refreshToken, { env, fetchImpl });
    }

    const connection = await tokens.getConnection(input.userId);

    return (
      connection ?? {
        account: account.email,
        connectedAt: Math.floor(Date.now() / 1000),
      }
    );
  }

  async function checkSharedDrive(): Promise<WorkspaceCheck> {
    const name = "Shared Drive for completed envelopes";
    const destination = resolveWorkspaceSetting(
      "files.exportDestination",
      stored,
      env,
    ).value;

    if (!destination) {
      return {
        id: "files.destination",
        message: "No Shared Drive is chosen, so no copies are kept.",
        name,
        ok: false,
      };
    }

    try {
      const drive = await driveJson<{
        capabilities?: { canAddChildren?: boolean };
        name?: string;
      }>(
        fetchImpl,
        await serviceAccountToken({ scopes: [GOOGLE_SCOPES.drive] }),
        "Reading the Shared Drive",
        `${DRIVE_API_BASE_URL}/drives/${encodeURIComponent(destination)}?fields=name,capabilities(canAddChildren)`,
      );
      const canAdd = drive.capabilities?.canAddChildren === true;

      return {
        id: "files.destination",
        message: canAdd
          ? `Copies go to "${drive.name ?? destination}".`
          : `The service account can see "${drive.name ?? destination}" but not add to it. Make it a Content manager of the Shared Drive.`,
        name,
        ok: canAdd,
      };
    } catch (error) {
      return {
        id: "files.destination",
        message: describeDriveFailure(error),
        name,
        ok: false,
      };
    }
  }

  async function checkLabel(): Promise<WorkspaceCheck | null> {
    if (!label.labelId) {
      return null;
    }

    const name = "Drive label on the copies";

    try {
      const found = await getDriveLabel(
        label.labelId,
        await serviceAccountToken({
          scopes: [GOOGLE_SCOPES.driveLabelsReadonly],
        }),
        fetchImpl,
      );
      const missing = Object.keys(label.fields).filter(
        (fieldId) => !found.fields?.some((field) => field.id === fieldId),
      );
      const fields = (found.fields ?? [])
        .map(
          (field) =>
            `${field.properties?.displayName ?? field.id} (${field.id}, ${fieldKind(field) ?? "other"})`,
        )
        .join(", ");

      return {
        id: "files.label",
        message:
          missing.length > 0
            ? `These fields are not on the label: ${missing.join(", ")}. Its fields: ${fields || "none"}.`
            : `"${found.properties?.title ?? label.labelId}" is applied. Its fields: ${fields || "none"}.`,
        name,
        ok: missing.length === 0,
      };
    } catch (error) {
      return {
        id: "files.label",
        message: describeDriveFailure(error),
        name,
        ok: false,
      };
    }
  }

  function checkPicker(): WorkspaceCheck {
    const missing = [
      !client &&
        "an OAuth client (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or Google sign-in)",
      !picker.apiKey && "the Picker API key",
      !picker.appId && "the Cloud project number",
    ].filter((item): item is string => Boolean(item));

    return {
      id: "files.picker",
      message:
        missing.length === 0
          ? "People can connect Google Drive and start envelopes from it."
          : `Starting from Drive needs ${missing.join(", ")}.`,
      name: "Start from Google Drive",
      ok: missing.length === 0,
    };
  }

  return {
    canImport: Boolean(client && picker.ready),
    async check() {
      const checks = [checkPicker(), await checkSharedDrive()];
      const labelCheck = await checkLabel();

      return labelCheck ? [...checks, labelCheck] : checks;
    },
    connection: (userId) => tokens.getConnection(userId),
    disconnect: (userId) => tokens.disconnect(userId),
    async exportExecutedCopies(request) {
      return exportToSharedDrive(request, {
        fetchImpl,
        getAccessToken: serviceAccountToken,
        label,
      });
    },
    finishConnect,
    async importFile({ fileId, userId }) {
      if (!isDriveFileId(fileId)) {
        throw new FileImportError("Choose a file from Google Drive.");
      }

      const accessToken = await tokens.getAccessToken(userId);
      const pdf = await exportGoogleFileToPdf(
        { accessToken, fileId },
        { fetchImpl },
      );

      return {
        bytes: pdf.bytes,
        fileName: pdf.fileName,
        sourceFileId: fileId,
        sourceUrl: driveFileUrl(fileId),
      };
    },
    name: "Google Drive",
    normalizeDestination: extractDriveId,
    async pickerConfig(userId) {
      if (!client || !picker.apiKey || !picker.appId) {
        throw new FilesConnectionError(
          "not_configured",
          "The Google Drive picker is not set up on this site.",
        );
      }

      return {
        accessToken: await tokens.getAccessToken(userId),
        apiKey: picker.apiKey,
        appId: picker.appId,
        mimeTypes: PICKER_MIME_TYPES,
        provider: "google",
      };
    },
    async startConnect({ email, redirectUri, state }) {
      const { challenge, verifier } = createPkcePair();

      return {
        secret: verifier,
        url: buildAuthorizationUrl({
          client: requireClient(),
          codeChallenge: challenge,
          env,
          loginHint: email,
          redirectUri,
          state,
        }),
      };
    },
  };
}

/** What a failed Drive call means, for the administrator. */
export function describeDriveFailure(error: unknown): string {
  if (!(error instanceof DriveApiError)) {
    return errorMessage(error);
  }

  const { reason, status } = error;

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

/**
 * Whether either part is set up: a Shared Drive for copies, or the Picker
 * with an OAuth client for people to connect with. Until then the package
 * offers no files (index.ts).
 */
export function isGoogleFilesSetUp(
  stored: WorkspaceSettings | null,
  env: EnvSource,
): boolean {
  return Boolean(
    resolveWorkspaceSetting("files.exportDestination", stored, env).value ||
    (readDriveOAuthClient(env) && readPickerConfig(stored, env).ready),
  );
}
