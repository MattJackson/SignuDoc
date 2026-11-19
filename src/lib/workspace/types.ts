import type { EnvSource } from "../utils/env.ts";
import type { WorkspaceSettingKey, WorkspaceSettings } from "./settings.ts";

// What SignuDoc asks of the services an organization works in, with no
// provider in it. Each capability is its own contract: a directory of
// people, files, and an add-in in the mail and file apps. A provider is
// one self-contained folder under providers/ that exports a
// WorkspaceProviderPackage offering the capabilities it has; the registry
// (registry.ts) lists the installed packages, and configuration picks a
// provider per capability. So an install can take everything from one
// provider (Google Workspace, Microsoft 365) or mix them (Okta for the
// directory, Box for files).
//
// App code uses only these contracts and the registry, never a provider
// folder. Everything is optional: a capability with no provider configured
// is null, and the app behaves as it does without it.

/** The capabilities configuration chooses a provider for. */
export const WORKSPACE_CAPABILITIES = ["directory", "files", "addIn"] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/** What a provider package is given to build a capability. */
export type WorkspaceContext = {
  env: EnvSource;
  /** The stored workspace settings (settings.ts), environment not applied. */
  settings: WorkspaceSettings;
};

// --- Directory ---------------------------------------------------------

export type DirectoryPerson = { email: string; name: string };

export type DirectoryGroup = { email: string; name: string };

/** One person's own entry, as far as SignuDoc reads it. */
export type DirectoryEntry = {
  /** Accounts the provider keeps but that cannot sign in, like suspended. */
  archived: boolean;
  email: string;
  /** The manager's address, lower-cased, or null when none is named. */
  managerEmail: string | null;
  name: string;
  suspended: boolean;
};

/**
 * A directory call that failed. "Could not ask" is never read as "not
 * there": callers that act on an answer (offboarding) stop on this.
 */
export class DirectoryError extends Error {
  /** The provider's HTTP status, or null when it could not be reached. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DirectoryError";
    this.status = status;
  }
}

/** The organization's directory, read-only. */
export interface WorkspaceDirectory {
  /**
   * One person's entry, or null when the directory has no such person
   * (never existed, or deleted). Any other failure throws DirectoryError.
   */
  getPerson(email: string): Promise<DirectoryEntry | null>;
  /** Whether the person is in the group, directly or through another. */
  isGroupMember(groupEmail: string, memberEmail: string): Promise<boolean>;
  /** Groups the person is a direct member of. */
  listPersonGroups(email: string): Promise<DirectoryGroup[]>;
  /** Active people whose name or address starts with the term. */
  searchPeople(term: string, limit?: number): Promise<DirectoryPerson[]>;
}

// --- Files -------------------------------------------------------------

/** A file a person picked in the provider's own picker, as a PDF. */
export type ImportedDocument = {
  bytes: Uint8Array;
  /** The PDF's name: the source's name ending in .pdf. */
  fileName: string;
  /** The provider's id for the file that was picked. */
  sourceFileId: string;
  /** A link back to the source, when the provider has one. */
  sourceUrl: string | null;
};

/** One of an envelope's executed copies. */
export type ExecutedCopy = {
  bytes: Uint8Array;
  fileName: string;
  kind: "certificate" | "signed";
  /** Hex SHA-256 of bytes, so a retry can find what is already there. */
  sha256: string;
};

/**
 * Facts about a completed envelope that a provider may attach to the copy
 * (Drive labels, SharePoint columns, Box metadata). Values are already
 * formatted; null means unknown.
 */
export type ExportMetadata = Readonly<Record<string, string | null>>;

export type ExportRequest = {
  copies: readonly ExecutedCopy[];
  /** The shared location an administrator chose (a Shared Drive id). */
  destination: string;
  envelopeId: string;
  /** Folders under the destination, outermost first. */
  folderPath: readonly string[];
  metadata: ExportMetadata;
};

export type ExportResult = {
  files: Array<{
    id: string;
    kind: ExecutedCopy["kind"];
    url: string | null;
  }>;
  /**
   * Why the metadata could not be attached, or null. The copy itself
   * still counts as made.
   */
  metadataProblem: string | null;
};

/** An export that failed. A permanent one is not tried again by itself. */
export class ExportError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.name = "ExportError";
    this.permanent = permanent;
  }
}

/**
 * The facts about a completed envelope that can go into ExportMetadata,
 * by key, with their names for the administrator. The provider decides
 * where each goes (google.driveLabelFields maps Drive label fields to
 * these keys).
 */
export const EXPORT_METADATA_KEYS = [
  "title",
  "senderName",
  "senderEmail",
  "completedDate",
  "counterparty",
  "counterpartyEmail",
  "envelopeId",
] as const;

export type ExportMetadataKey = (typeof EXPORT_METADATA_KEYS)[number];

export const EXPORT_METADATA_NAMES: Record<ExportMetadataKey, string> = {
  completedDate: "Completed date (YYYY-MM-DD)",
  counterparty: "Counterparty (first outside signer's name)",
  counterpartyEmail: "Counterparty's email address",
  envelopeId: "Envelope ID",
  senderEmail: "Sender's email address",
  senderName: "Sender's name",
  title: "Envelope title",
};

export function isExportMetadataKey(
  value: unknown,
): value is ExportMetadataKey {
  return (
    typeof value === "string" &&
    (EXPORT_METADATA_KEYS as readonly string[]).includes(value)
  );
}

/** A person's own connection to the provider's files. */
export type FilesConnection = {
  /** The provider account that agreed, such as a Google address. */
  account: string;
  /** Unix seconds. */
  connectedAt: number;
};

/**
 * What the person's browser needs to show the provider's own file picker,
 * tagged with the provider so the page loads the right one. The access
 * token is short-lived and can only reach files the person picks.
 */
export type FilesPickerConfig = {
  accessToken: string;
  /** The browser API key, restricted to this site and the Picker API. */
  apiKey: string;
  /** The Cloud project number. */
  appId: string;
  /** The kinds of file offered: those that can be made into a PDF. */
  mimeTypes: readonly string[];
  provider: "google";
};

export type FilesConnectionErrorCode =
  /** The person said no, or did not grant what is needed. */
  | "denied"
  /** The provider could not be reached or answered badly. */
  | "failed"
  /** The site is not set up for per-person connections. */
  | "not_configured"
  /** The person has no connection (any more). */
  | "not_connected"
  /** The person agreed with an account that is not theirs on this site. */
  | "wrong_account";

/** A per-person connection that cannot be made or used. */
export class FilesConnectionError extends Error {
  readonly code: FilesConnectionErrorCode;

  constructor(code: FilesConnectionErrorCode, message: string) {
    super(message);
    this.name = "FilesConnectionError";
    this.code = code;
  }
}

/** A file that cannot be made into a PDF: the message is for the person. */
export class FileImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileImportError";
  }
}

/**
 * Files: start an envelope from one, and keep executed copies in one place.
 *
 * Starting from a file uses each person's own connection, made with the
 * provider's OAuth flow (authorization code with PKCE). The app keeps the
 * state, the return path and the redirect address
 * (/api/workspace/files/callback); the provider builds the address to send
 * the person to, and turns the code that comes back into a connection it
 * keeps, encrypted (workspace/file-connections.ts).
 *
 * The provider builds this once either part is set up, and null before.
 * Each part stays off until it is set up on its own: canImport is false
 * without the picker's setup, and nothing is exported while
 * files.exportDestination is empty.
 */
export interface WorkspaceFiles {
  /** Whether people can start envelopes from a file. */
  readonly canImport: boolean;
  /** The person's connection, or null when they have not connected. */
  connection(userId: string): Promise<FilesConnection | null>;
  /** Forgets the person's connection and revokes it. True when there was one. */
  disconnect(userId: string): Promise<boolean>;
  /**
   * Puts the executed copies into the shared location. Safe to call again
   * after a failure: copies already there are found, not made twice.
   */
  exportExecutedCopies(request: ExportRequest): Promise<ExportResult>;
  /**
   * Turns the provider's answer into the person's connection, and keeps
   * it. Throws FilesConnectionError for an answer that cannot be used.
   */
  finishConnect(input: {
    email: string;
    params: URLSearchParams;
    redirectUri: string;
    /** What startConnect returned as secret. */
    secret: string;
    userId: string;
  }): Promise<FilesConnection>;
  /**
   * Reads a file the person picked, with their own connection to the
   * provider, converted to PDF. Throws FilesConnectionError when the
   * connection is missing, FileImportError when the file cannot be used.
   */
  importFile(input: {
    fileId: string;
    signal?: AbortSignal;
    userId: string;
  }): Promise<ImportedDocument>;
  /** The provider's name for its files, for buttons: "Google Drive". */
  readonly name: string;
  /**
   * The destination's id from what an administrator pasted (the id itself,
   * or its address in the browser), or null when it is neither.
   */
  normalizeDestination(value: string): string | null;
  /** What the picker needs. Throws FilesConnectionError when it cannot. */
  pickerConfig(userId: string): Promise<FilesPickerConfig>;
  /**
   * Where to send the person to connect, and a secret (a PKCE verifier)
   * for the app to keep until they come back.
   */
  startConnect(input: {
    email: string;
    redirectUri: string;
    state: string;
  }): Promise<{ secret: string; url: string }>;
}

// --- Add-in ------------------------------------------------------------

/**
 * The provider's add-in in its mail and file apps (a Google Workspace
 * add-on, an Outlook add-in). The provider verifies that each request came
 * from it, matches the person by the address it vouches for, and reads
 * only the open message or the selected file. Its answer is in the
 * provider's own format.
 */
export interface WorkspaceAddIn {
  handle(action: string, request: Request): Promise<Response>;
}

/** What the site tells the provider about itself for the add-in. */
export type WorkspaceAddInSite = {
  brandColor: string | null;
  /** The organization's name, when one is set. */
  name: string | null;
  /** The site's address, or null when it does not know it. */
  url: string | null;
};

/**
 * How an administrator deploys the add-in: the file and steps for the
 * provider's own tools, and the values the provider gives back that the
 * site needs to trust its requests (not secret).
 */
export type WorkspaceAddInDeployment = {
  /** The file to give the provider, or null until the site knows its address. */
  file: { content: string; name: string } | null;
  /** Why the provider cannot call the add-in here, or null when it can. */
  problem: string | null;
  /** Whether the add-in answers requests: every value below is set. */
  ready: boolean;
  /** In order; command is something to run, when there is one. */
  steps: Array<{ command: string | null; text: string }>;
  values: Array<{
    /** The environment variable that sets it, or the setting. */
    env: string;
    label: string;
    /** The workspace setting it is saved as (settings.ts). */
    setting: WorkspaceSettingKey;
    source: "env" | "none" | "settings";
    value: string | null;
  }>;
};

// --- Setup and health --------------------------------------------------

/** How the site itself reaches the provider, for the administrator. */
export type WorkspaceIdentity = {
  /**
   * The account the site acts as (a Google service account, an app
   * registration), or null when it has none.
   */
  account: string | null;
  configured: boolean;
  /** One sentence: where the identity comes from, or what to set. */
  description: string;
};

/** One check an administrator can run from Settings. */
export type WorkspaceCheck = {
  /** Stable, for tests and for the page to place it. */
  id: string;
  message: string;
  name: string;
  ok: boolean;
};

/** What can be checked: the site's identity, a capability, or a part of one. */
export type WorkspaceCheckTarget =
  "adminGroup" | "identity" | WorkspaceCapability;

/**
 * Who runs a check: the administrator in Settings. A directory check looks
 * them up, and the administrator group check asks whether they are in it.
 */
export type WorkspaceCheckContext = { email?: string };

/** Every provider has this: its identity, and checks for Settings. */
export interface WorkspaceSetup {
  /** How to deploy the add-in, for a provider that has one. */
  addInDeployment?(site: WorkspaceAddInSite): WorkspaceAddInDeployment;
  /** Runs the checks for one target. Never throws; [] when not offered. */
  check(
    target: WorkspaceCheckTarget,
    context?: WorkspaceCheckContext,
  ): Promise<WorkspaceCheck[]>;
  identity(): Promise<WorkspaceIdentity>;
}

// --- The package -------------------------------------------------------

/**
 * One provider: a folder under providers/ exporting this. Only the
 * capabilities it has are present. Each builder returns null when the
 * capability is turned off or not set up, and the caller then behaves as
 * if there were no provider.
 */
export type WorkspaceProviderPackage = {
  readonly addIn?: (context: WorkspaceContext) => WorkspaceAddIn | null;
  readonly directory?: (context: WorkspaceContext) => WorkspaceDirectory | null;
  readonly files?: (context: WorkspaceContext) => WorkspaceFiles | null;
  /** Lower-case, stable: what WORKSPACE_PROVIDER and Settings name. */
  readonly id: string;
  /** For people: "Google Workspace". */
  readonly label: string;
  readonly setup: (context: WorkspaceContext) => WorkspaceSetup;
};
