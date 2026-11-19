import type { EnvSource } from "../../../utils/env.ts";
import {
  resolveWorkspaceSetting,
  type WorkspaceSettings,
} from "../../settings.ts";
import {
  DirectoryError,
  type DirectoryEntry,
  type DirectoryGroup,
  type DirectoryPerson,
  type WorkspaceContext,
  type WorkspaceDirectory,
} from "../../types.ts";
import { isDirectoryEnabled } from "../../directory-settings.ts";
import {
  GOOGLE_SCOPES,
  googleCredentialsFor,
  type GoogleCredentials,
} from "./credentials.ts";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  googleTimeoutSignal,
  googleUrl,
} from "./endpoints.ts";

// The organization's Google Workspace directory, read through the Admin SDK
// Directory API with plain fetch and the site's credentials
// (credentials.ts): people to suggest as recipients, group membership for
// the administrator group, and one person's own entry.
//
// Two ways to give the site read access, both read-only:
//
// - "admin-role" (preferred): in the Admin console, the service account the
//   site runs as is assigned an administrator role that may only read users
//   and groups. It then calls the API as itself. No domain-wide delegation,
//   so it can never act as anyone in the organization.
// - "delegation": domain-wide delegation for the service account, limited
//   to the two read-only directory scopes, and google.adminSubject
//   (GOOGLE_WORKSPACE_ADMIN_SUBJECT) naming an administrator to read the
//   directory as.
//
// Google's error bodies can echo what was sent, so errors carry the status
// only.

const DIRECTORY_BASE_URL = "https://admin.googleapis.com/admin/directory/v1";
const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_GROUP_PAGES = 5;
const MAX_TERM_LENGTH = 64;
const DEFAULT_RESULTS = 8;

/**
 * The Workspace customer a directory is read for when no customer ID is
 * set: the organization the app's own account (or the administrator it acts
 * as) belongs to.
 */
export const OWN_GOOGLE_CUSTOMER = "my_customer";

export type GoogleDirectoryAccessMode = "admin-role" | "delegation";

export type GoogleDirectoryConfig = {
  /** The Workspace administrator to act as, in delegation mode. */
  adminSubject: string | null;
  /** The Workspace customer, "my_customer" for the app's own. */
  customer: string;
  mode: GoogleDirectoryAccessMode;
};

export function readGoogleDirectoryConfig(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
): GoogleDirectoryConfig {
  const adminSubject =
    resolveWorkspaceSetting("google.adminSubject", stored, env)
      .value?.trim()
      .toLowerCase() || null;

  return {
    adminSubject,
    customer:
      resolveWorkspaceSetting("google.customerId", stored, env).value ??
      OWN_GOOGLE_CUSTOMER,
    mode: adminSubject ? "delegation" : "admin-role",
  };
}

/**
 * Whether the customer ID still has to be entered. With domain-wide
 * delegation the directory is read as an administrator of the Workspace,
 * so it can stay empty; with the administrator role it is needed.
 */
export function needsCustomerId(config: GoogleDirectoryConfig): boolean {
  return (
    config.mode === "admin-role" && config.customer === OWN_GOOGLE_CUSTOMER
  );
}

/** What a status means, for the administrator testing access. */
export function describeDirectoryStatus(status: number | null): string {
  switch (status) {
    case null:
      return "Google's directory could not be reached.";
    case 400:
      return "Google refused the request (400). With the admin role, enter the Customer ID from Admin console, Account settings; also check the group address.";
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

type UserResponse = {
  archived?: boolean;
  name?: { fullName?: string };
  primaryEmail?: string;
  relations?: Array<{ customType?: string; type?: string; value?: string }>;
  suspended?: boolean;
};

/**
 * The manager's address from a user's relations. Google keeps the manager
 * as a relation of type "manager" whose value is the address. A relation
 * with a custom type is the organization's own and is not read as one.
 */
export function managerFromRelations(
  relations: UserResponse["relations"],
): string | null {
  for (const relation of relations ?? []) {
    const value = relation.value?.trim().toLowerCase();

    if (
      relation.type === "manager" &&
      value &&
      /^[^@\s]+@[^@\s]+$/.test(value)
    ) {
      return value;
    }
  }

  return null;
}

type GroupsResponse = {
  groups?: Array<{ email?: string; name?: string }>;
  nextPageToken?: string;
};

type CreateGoogleDirectoryOptions = {
  config: GoogleDirectoryConfig;
  credentials: GoogleCredentials;
  /** Read for a test stand-in in place of Google (endpoints.ts). */
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a request to Google may take, in milliseconds. */
  timeoutMs?: number;
};

/** The directory, read with these settings and credentials. */
export function createGoogleDirectory({
  config,
  credentials,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
}: CreateGoogleDirectoryOptions): WorkspaceDirectory {
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
    let token: string;

    try {
      token = await credentials.getAccessToken({
        scopes: [scope],
        ...(config.mode === "delegation" && config.adminSubject
          ? { subject: config.adminSubject }
          : {}),
      });
    } catch (error) {
      // The token exchange says only its status (credentials.ts).
      throw new DirectoryError(
        error instanceof Error ? error.message : describeDirectoryStatus(null),
        null,
      );
    }

    let response: Response;

    try {
      response = await fetchImpl(
        googleUrl(`${DIRECTORY_BASE_URL}${path}`, env),
        {
          headers: { authorization: `Bearer ${token}` },
          signal: googleTimeoutSignal(timeoutMs),
        },
      );
    } catch {
      throw directoryError(null);
    }

    if (!response.ok) {
      throw directoryError(response.status);
    }

    return response.json();
  }

  async function searchPeople(
    term: string,
    limit = DEFAULT_RESULTS,
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

  async function listPersonGroups(email: string): Promise<DirectoryGroup[]> {
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

  async function getPerson(email: string): Promise<DirectoryEntry | null> {
    const userKey = email.trim().toLowerCase();

    return cached(`user|${userKey}`, async () => {
      const params = new URLSearchParams({
        fields: "primaryEmail,name/fullName,suspended,archived,relations",
        projection: "basic",
        viewType: "admin_view",
      });
      let body: UserResponse;

      try {
        body = (await get(
          `/users/${encodeURIComponent(userKey)}?${params.toString()}`,
          GOOGLE_SCOPES.directoryUserReadonly,
        )) as UserResponse;
      } catch (error) {
        if (error instanceof DirectoryError && error.status === 404) {
          return null;
        }

        throw error;
      }

      return {
        archived: body.archived === true,
        email: body.primaryEmail?.toLowerCase() ?? userKey,
        managerEmail: managerFromRelations(body.relations),
        name: body.name?.fullName ?? "",
        suspended: body.suspended === true,
      };
    });
  }

  return { getPerson, isGroupMember, listPersonGroups, searchPeople };
}

type SharedDirectory = {
  credentials: GoogleCredentials;
  directory: WorkspaceDirectory;
  key: string;
};

declare global {
  var __signudocGoogleDirectory: SharedDirectory | undefined;
}

/**
 * The directory for these settings, kept between requests so its short
 * cache spares Google the same question from every keystroke. Made again
 * when the settings or the credentials change, so it never answers for an
 * old setup.
 */
export function sharedGoogleDirectory(
  config: GoogleDirectoryConfig,
  credentials: GoogleCredentials,
): WorkspaceDirectory {
  const key = JSON.stringify([
    config.adminSubject,
    config.customer,
    config.mode,
  ]);
  const shared = globalThis.__signudocGoogleDirectory;

  if (shared && shared.key === key && shared.credentials === credentials) {
    return shared.directory;
  }

  const directory = createGoogleDirectory({ config, credentials });

  globalThis.__signudocGoogleDirectory = { credentials, directory, key };

  return directory;
}

const warned = new Set<string>();

/**
 * The directory capability (index.ts): null unless the directory is turned
 * on and the site has a Google identity. A key that does not parse counts
 * as no identity, logged once, so the optional parts stay out of the way.
 */
export function googleDirectoryFor(
  context: WorkspaceContext,
  getCredentials: () => GoogleCredentials | null = () =>
    googleCredentialsFor(context.env),
): WorkspaceDirectory | null {
  if (!isDirectoryEnabled(context.settings, context.env)) {
    return null;
  }

  let credentials: GoogleCredentials | null;

  try {
    credentials = getCredentials();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";

    if (!warned.has(message)) {
      warned.add(message);
      console.warn("[google] The directory is not available:", message);
    }

    return null;
  }

  if (!credentials) {
    return null;
  }

  const config = readGoogleDirectoryConfig(context.settings, context.env);

  // The shared one keeps its short cache between requests; another
  // environment (a test) gets its own.
  return context.env === process.env
    ? sharedGoogleDirectory(config, credentials)
    : createGoogleDirectory({ config, credentials, env: context.env });
}
