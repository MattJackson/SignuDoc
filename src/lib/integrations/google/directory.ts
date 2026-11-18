import { readEnv, type EnvSource } from "../../utils/env.ts";
import {
  getGoogleCredentials,
  GOOGLE_SCOPES,
  type GoogleCredentials,
} from "./credentials.ts";

// The organization's Google Workspace directory, read through the Admin SDK
// Directory API with plain fetch and the shared credentials (credentials.ts):
// people to suggest as recipients, and group membership for the
// administrator group.
//
// Two ways to give the app read access, both read-only:
//
// - "admin-role" (preferred): in the Admin console, the service account the
//   app runs as is assigned an administrator role that may only read users
//   and groups. It then calls the API as itself. No domain-wide delegation,
//   so it can never act as anyone in the organization.
// - "delegation": domain-wide delegation for the service account, limited
//   to the two read-only directory scopes, and GOOGLE_WORKSPACE_ADMIN_SUBJECT
//   naming an administrator to read the directory as.
//
// It is off until an administrator turns it on (Settings, Google Workspace,
// or GOOGLE_WORKSPACE_DIRECTORY=on), so an install on Google Cloud does not
// start asking a directory it was never given.
//
// Google's error bodies can echo what was sent, so errors carry the status
// only.

const DIRECTORY_BASE_URL = "https://admin.googleapis.com/admin/directory/v1";
const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_GROUP_PAGES = 5;
const MAX_TERM_LENGTH = 64;
export const MAX_DIRECTORY_RESULTS = 8;

export type DirectoryAccessMode = "admin-role" | "delegation";

export type DirectoryConfig = {
  /** The Workspace administrator to act as, in delegation mode. */
  adminSubject: string | null;
  /** The Workspace customer, "my_customer" for the app's own. */
  customer: string;
  enabled: boolean;
  /** Where the on/off choice comes from. */
  enabledSource: "default" | "env" | "settings";
  mode: DirectoryAccessMode;
};

/** The stored values the directory reads (integration-settings.ts). */
export type StoredDirectorySettings = Readonly<
  Partial<
    Record<
      "google.adminSubject" | "google.customerId" | "google.directory",
      string
    >
  >
>;

export function readDirectoryConfig(
  env: EnvSource = process.env,
  stored: StoredDirectorySettings | null = null,
): DirectoryConfig {
  const envChoice = readEnv(env, "GOOGLE_WORKSPACE_DIRECTORY")?.toLowerCase();
  const storedChoice = stored?.["google.directory"]?.trim().toLowerCase();
  const adminSubject =
    readEnv(env, "GOOGLE_WORKSPACE_ADMIN_SUBJECT") ??
    (stored?.["google.adminSubject"]?.trim() || null);

  return {
    adminSubject,
    customer:
      readEnv(env, "GOOGLE_WORKSPACE_CUSTOMER_ID") ??
      (stored?.["google.customerId"]?.trim() || "my_customer"),
    enabled: (envChoice ?? storedChoice) === "on",
    enabledSource: envChoice ? "env" : storedChoice ? "settings" : "default",
    mode: adminSubject ? "delegation" : "admin-role",
  };
}

export class DirectoryError extends Error {
  /** Google's HTTP status, or null when Google could not be reached. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DirectoryError";
    this.status = status;
  }
}

export type DirectoryPerson = { email: string; name: string };

export type DirectoryGroup = { email: string; name: string };

export interface DirectoryClient {
  /** Groups the user is a direct member of. */
  listUserGroups(email: string): Promise<DirectoryGroup[]>;
  /** Whether the user is in the group, directly or through another group. */
  isGroupMember(groupEmail: string, memberEmail: string): Promise<boolean>;
  /** Active people whose name or email address starts with the term. */
  searchUsers(term: string, limit?: number): Promise<DirectoryPerson[]>;
}

type FetchLike = typeof fetch;

type CreateDirectoryClientOptions = {
  config: DirectoryConfig;
  credentials: GoogleCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
};

/** What a status means, for the administrator testing access. */
export function describeDirectoryStatus(status: number | null): string {
  switch (status) {
    case null:
      return "Google's directory could not be reached.";
    case 400:
      return "Google refused the request (400). Check the customer ID and the group address.";
    case 401:
    case 403:
      return `Google did not allow the directory to be read (${String(status)}). Check that the service account has the read-only administrator role, or, with domain-wide delegation, that both directory scopes are granted.`;
    case 404:
      return "Google did not find it (404).";
    case 429:
      return "Google is limiting requests right now (429). Try again in a minute.";
    default:
      return `Google's directory answered with ${String(status)}.`;
  }
}

function directoryError(status: number | null): DirectoryError {
  return new DirectoryError(describeDirectoryStatus(status), status);
}

/** The words of a term that Google's query syntax can take, at most three. */
export function cleanSearchTerm(term: string): string[] {
  return term
    .slice(0, MAX_TERM_LENGTH)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}._@+-]/gu, ""))
    .filter((token) => token.length > 0)
    .slice(0, 3);
}

/**
 * The Directory API queries for a term. One word could be a first name, a
 * last name or the start of an address, and the API has no "or", so each is
 * asked; two words are a first and last name.
 * https://developers.google.com/workspace/admin/directory/v1/guides/search-users
 */
export function buildUserQueries(term: string): string[] {
  const tokens = cleanSearchTerm(term);
  const active = "isSuspended=false";

  if (tokens.length === 0) {
    return [];
  }

  if (tokens.length === 1) {
    const [token] = tokens as [string];

    if (token.includes("@")) {
      return [`email:${token}* ${active}`];
    }

    return [
      `givenName:${token}* ${active}`,
      `familyName:${token}* ${active}`,
      `email:${token}* ${active}`,
    ];
  }

  const [first, second] = tokens as [string, string];

  return [`givenName:${first}* familyName:${second}* ${active}`];
}

type UsersResponse = {
  users?: Array<{
    archived?: boolean;
    name?: { fullName?: string };
    primaryEmail?: string;
    suspended?: boolean;
  }>;
};

type GroupsResponse = {
  groups?: Array<{ email?: string; name?: string }>;
  nextPageToken?: string;
};

export function createDirectoryClient({
  config,
  credentials,
  fetchImpl = fetch,
  now = Date.now,
}: CreateDirectoryClientOptions): DirectoryClient {
  const cache = new Map<string, { expiresAt: number; value: unknown }>();

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);

    if (hit && hit.expiresAt > now()) {
      return hit.value as T;
    }

    const value = await load();

    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear();
    }

    cache.set(key, { expiresAt: now() + CACHE_MS, value });

    return value;
  }

  async function get(path: string, scope: string): Promise<unknown> {
    const token = await credentials.getAccessToken({
      scopes: [scope],
      ...(config.mode === "delegation" && config.adminSubject
        ? { subject: config.adminSubject }
        : {}),
    });
    let response: Response;

    try {
      response = await fetchImpl(`${DIRECTORY_BASE_URL}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw directoryError(null);
    }

    if (!response.ok) {
      throw directoryError(response.status);
    }

    return response.json();
  }

  async function searchUsers(
    term: string,
    limit = MAX_DIRECTORY_RESULTS,
  ): Promise<DirectoryPerson[]> {
    const queries = buildUserQueries(term);
    const max = Math.max(1, Math.min(limit, 20));

    if (queries.length === 0) {
      return [];
    }

    return cached(`users|${max}|${queries.join("|")}`, async () => {
      const pages = await Promise.all(
        queries.map((query) => {
          const params = new URLSearchParams({
            customer: config.customer,
            fields: "users(primaryEmail,name/fullName,suspended,archived)",
            maxResults: String(max),
            orderBy: "email",
            query,
          });

          return get(
            `/users?${params.toString()}`,
            GOOGLE_SCOPES.directoryUserReadonly,
          ) as Promise<UsersResponse>;
        }),
      );
      const people = new Map<string, DirectoryPerson>();

      for (const page of pages) {
        for (const user of page.users ?? []) {
          const email = user.primaryEmail?.toLowerCase();

          if (!email || user.suspended || user.archived || people.has(email)) {
            continue;
          }

          people.set(email, { email, name: user.name?.fullName ?? "" });
        }
      }

      return Array.from(people.values())
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.email.localeCompare(b.email),
        )
        .slice(0, max);
    });
  }

  async function listUserGroups(email: string): Promise<DirectoryGroup[]> {
    const userKey = email.trim().toLowerCase();

    return cached(`groups|${userKey}`, async () => {
      const groups: DirectoryGroup[] = [];
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
        const params = new URLSearchParams({
          maxResults: "200",
          userKey,
          ...(pageToken ? { pageToken } : {}),
        });
        const body = (await get(
          `/groups?${params.toString()}`,
          GOOGLE_SCOPES.directoryGroupReadonly,
        )) as GroupsResponse;

        for (const group of body.groups ?? []) {
          if (group.email) {
            groups.push({
              email: group.email.toLowerCase(),
              name: group.name ?? group.email,
            });
          }
        }

        if (!body.nextPageToken) {
          break;
        }

        pageToken = body.nextPageToken;
      }

      return groups;
    });
  }

  async function isGroupMember(
    groupEmail: string,
    memberEmail: string,
  ): Promise<boolean> {
    const group = groupEmail.trim().toLowerCase();
    const member = memberEmail.trim().toLowerCase();

    return cached(`member|${group}|${member}`, async () => {
      const body = (await get(
        `/groups/${encodeURIComponent(group)}/hasMember/${encodeURIComponent(member)}`,
        GOOGLE_SCOPES.directoryGroupReadonly,
      )) as { isMember?: unknown };

      return body.isMember === true;
    });
  }

  return { isGroupMember, listUserGroups, searchUsers };
}

type SharedDirectory = { client: DirectoryClient; key: string };

declare global {
  var __signudocDirectoryClient: SharedDirectory | undefined;
}

/**
 * The directory client for the current settings, or null when the directory
 * is off or there are no Google credentials. Made again when the settings
 * change, so the cache never answers for an old setup.
 */
export function getDirectoryClient(
  env: EnvSource = process.env,
  stored: StoredDirectorySettings | null = null,
): DirectoryClient | null {
  const config = readDirectoryConfig(env, stored);

  if (!config.enabled) {
    return null;
  }

  const credentials = getGoogleCredentials();

  if (!credentials) {
    return null;
  }

  return getDirectoryClientFor(config, credentials);
}

/** A client for these settings even when the directory is off, for testing. */
export function getDirectoryClientFor(
  config: DirectoryConfig,
  credentials: GoogleCredentials,
): DirectoryClient {
  const key = JSON.stringify([
    config.adminSubject,
    config.customer,
    config.mode,
    credentials.source,
  ]);
  const shared = globalThis.__signudocDirectoryClient;

  if (shared && shared.key === key) {
    return shared.client;
  }

  const client = createDirectoryClient({ config, credentials });

  globalThis.__signudocDirectoryClient = { client, key };

  return client;
}
