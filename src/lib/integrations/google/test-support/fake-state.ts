import { randomBytes, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// What the fake Google server (fake-google.ts) keeps, and the small HTTP
// helpers its parts share. Everything is in memory and lost when it stops.

/** A person in the fake Workspace, or a personal Google account. */
export type FakeGoogleUser = {
  archived?: boolean;
  department?: string;
  email: string;
  /** False makes Google say the address is not verified. */
  emailVerified?: boolean;
  familyName: string;
  givenName: string;
  /**
   * The Workspace the account belongs to, sent as the ID token's hd claim.
   * Left out, it is the address's domain; null makes a personal Google
   * account, which has no hd.
   */
  hd?: string | null;
  id?: string;
  isAdmin?: boolean;
  /** The manager's address, listed in the user's relations as "manager". */
  manager?: string | null;
  orgUnitPath?: string;
  /** The profile picture's address, sent as the ID token's picture claim. */
  picture?: string;
  suspended?: boolean;
  title?: string;
};

export type FakeGroupMemberRole = "MANAGER" | "MEMBER" | "OWNER";

/** A Google Group. Members are addresses of users or of other groups. */
export type FakeGoogleGroup = {
  description?: string;
  email: string;
  id?: string;
  members?: Array<string | { email: string; role?: FakeGroupMemberRole }>;
  name?: string;
};

export type FakeSharedDrive = { id?: string; name: string };

export type StoredUser = {
  archived: boolean;
  department: string | null;
  email: string;
  emailVerified: boolean;
  familyName: string;
  givenName: string;
  hd: string | null;
  id: string;
  isAdmin: boolean;
  manager: string | null;
  orgUnitPath: string;
  picture: string | null;
  suspended: boolean;
  title: string | null;
};

export type StoredGroup = {
  description: string;
  email: string;
  id: string;
  members: Array<{ email: string; role: FakeGroupMemberRole }>;
  name: string;
};

export type StoredDrive = { createdTime: string; id: string; name: string };

export type StoredPermission = {
  domain?: string;
  emailAddress?: string;
  id: string;
  role: string;
  type: string;
};

export type StoredFile = {
  appProperties: Record<string, string>;
  content: Buffer;
  createdTime: string;
  description: string | null;
  /** The shared drive the file is in, or null for My Drive. */
  driveId: string | null;
  id: string;
  mimeType: string;
  modifiedTime: string;
  name: string;
  /** Who made it: the user the token acts as, or the service account. */
  ownerEmail: string | null;
  parents: string[];
  permissions: StoredPermission[];
  properties: Record<string, string>;
  /** For a converted file, the type it was uploaded as. */
  sourceMimeType: string | null;
  trashed: boolean;
  version: number;
};

export type FakeAccessToken = {
  /** The OAuth client or service account the token was issued to. */
  client: string;
  expiresAt: number;
  scopes: string[];
  /** The service account, when the token is one's. */
  serviceAccount: string | null;
  /** The user the token acts for: who signed in, or the delegation subject. */
  user: string | null;
};

export type PendingCode = {
  accessType: string | null;
  clientId: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  email: string;
  expiresAt: number;
  nonce: string | null;
  redirectUri: string;
  scope: string;
};

export type UploadSession = {
  contentType: string | null;
  fileId: string | null;
  metadata: Record<string, unknown>;
  query: URLSearchParams;
};

export type FakeGoogleState = {
  accessTokens: Map<string, FakeAccessToken>;
  /** The query of every authorization request, oldest first. */
  authorizations: Array<Record<string, string>>;
  codes: Map<string, PendingCode>;
  /**
   * The Workspace domains the directory lists. Empty: every account that
   * has a Workspace (an hd), personal accounts never.
   */
  directoryDomains: Set<string>;
  drives: Map<string, StoredDrive>;
  files: Map<string, StoredFile>;
  groups: Map<string, StoredGroup>;
  /** Signing keys made for IAM signJwt, by service account. */
  iamKeys: Map<string, KeyObject>;
  nextId: number;
  /** Authorization requests waiting for someone to choose an account. */
  pendingAuthorizations: Map<string, URLSearchParams>;
  refreshTokens: Map<
    string,
    { clientId: string; email: string; scope: string }
  >;
  /** Method and path of every request, newest last, at most 500. */
  requests: Array<{ method: string; path: string }>;
  /** Public keys of service accounts whose assertions are checked. */
  serviceAccountKeys: Map<string, KeyObject[]>;
  uploads: Map<string, UploadSession>;
  /** By lowercased address. */
  users: Map<string, StoredUser>;
};

export function createState(): FakeGoogleState {
  return {
    accessTokens: new Map(),
    authorizations: [],
    codes: new Map(),
    directoryDomains: new Set(),
    drives: new Map(),
    files: new Map(),
    groups: new Map(),
    iamKeys: new Map(),
    nextId: 1,
    pendingAuthorizations: new Map(),
    refreshTokens: new Map(),
    requests: [],
    serviceAccountKeys: new Map(),
    uploads: new Map(),
    users: new Map(),
  };
}

/** A new identifier, numeric like Google's user ids, or with a prefix. */
export function newId(state: FakeGoogleState, prefix = ""): string {
  const id = String(state.nextId);

  state.nextId += 1;

  return prefix
    ? `${prefix}${id.padStart(6, "0")}${randomBytes(4).toString("hex")}`
    : `1${id.padStart(20, "0")}`;
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

export function storeUser(state: FakeGoogleState, user: FakeGoogleUser) {
  const email = user.email.trim().toLowerCase();
  const existing = state.users.get(email);
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const stored: StoredUser = {
    archived: user.archived ?? false,
    department: user.department ?? null,
    email,
    emailVerified: user.emailVerified ?? true,
    familyName: user.familyName,
    givenName: user.givenName,
    hd: user.hd === undefined ? domain : user.hd,
    id: user.id ?? existing?.id ?? newId(state),
    isAdmin: user.isAdmin ?? false,
    manager: user.manager?.trim().toLowerCase() || null,
    orgUnitPath: user.orgUnitPath ?? "/",
    picture: user.picture ?? null,
    suspended: user.suspended ?? false,
    title: user.title ?? null,
  };

  state.users.set(email, stored);

  return stored;
}

export function storeGroup(state: FakeGoogleState, group: FakeGoogleGroup) {
  const email = group.email.trim().toLowerCase();
  const existing = state.groups.get(email);
  const stored: StoredGroup = {
    description: group.description ?? "",
    email,
    id: group.id ?? existing?.id ?? newId(state, "grp"),
    members: (group.members ?? []).map((member) =>
      typeof member === "string"
        ? { email: member.trim().toLowerCase(), role: "MEMBER" as const }
        : {
            email: member.email.trim().toLowerCase(),
            role: member.role ?? "MEMBER",
          },
    ),
    name: group.name ?? email,
  };

  state.groups.set(email, stored);

  return stored;
}

export function storeDrive(state: FakeGoogleState, drive: FakeSharedDrive) {
  const stored: StoredDrive = {
    createdTime: new Date().toISOString(),
    id: drive.id ?? newId(state, "0AFake"),
    name: drive.name,
  };

  state.drives.set(stored.id, stored);

  return stored;
}

export function findUser(
  state: FakeGoogleState,
  key: string,
): StoredUser | null {
  const lowered = key.trim().toLowerCase();

  return (
    state.users.get(lowered) ??
    Array.from(state.users.values()).find((user) => user.id === key) ??
    null
  );
}

/** Whether the user is in the Workspace the fake directory lists. */
export function inDirectory(state: FakeGoogleState, user: StoredUser): boolean {
  return (
    user.hd !== null &&
    (state.directoryDomains.size === 0 || state.directoryDomains.has(user.hd))
  );
}

export function findGroup(
  state: FakeGoogleState,
  key: string,
): StoredGroup | null {
  const lowered = key.trim().toLowerCase();

  return (
    state.groups.get(lowered) ??
    Array.from(state.groups.values()).find((group) => group.id === key) ??
    null
  );
}

/** One request, as the handlers see it. */
export type FakeRequest = {
  baseUrl: string;
  body: Buffer;
  method: string;
  path: string;
  query: URLSearchParams;
  request: IncomingMessage;
  response: ServerResponse;
  state: FakeGoogleState;
  /** The bearer token's grant, when the request carried a live one. */
  token: FakeAccessToken | null;
};

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response
    .writeHead(status, {
      "content-type": "application/json; charset=UTF-8",
      ...headers,
    })
    .end(JSON.stringify(body));
}

/** An error in the shape Google's JSON APIs use. */
export function sendGoogleError(
  response: ServerResponse,
  status: number,
  reason: string,
  message: string,
) {
  sendJson(response, status, {
    error: {
      code: status,
      errors: [{ domain: "global", message, reason }],
      message,
    },
  });
}

export function readJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Checks that the request carries a token with one of these scopes, and
 * answers 401 or 403 the way Google does when it does not.
 */
export function requireScope(
  context: FakeRequest,
  accepted: (scope: string) => boolean,
): FakeAccessToken | null {
  const token = context.token;

  if (!token) {
    sendGoogleError(
      context.response,
      401,
      "authError",
      "Request had invalid authentication credentials.",
    );
    return null;
  }

  if (!token.scopes.some(accepted)) {
    sendGoogleError(
      context.response,
      403,
      "insufficientPermissions",
      "Request had insufficient authentication scopes.",
    );
    return null;
  }

  return token;
}

// A partial response mask, as in ?fields=files(id,name),nextPageToken.
// https://developers.google.com/workspace/drive/api/guides/fields-parameter
export type FieldMask = Map<string, FieldMask | true>;

export class FieldMaskError extends Error {}

export function parseFieldMask(fields: string): FieldMask {
  const text = fields.replace(/\s+/g, "");
  let index = 0;

  function parseList(): FieldMask {
    const mask: FieldMask = new Map();

    for (;;) {
      const start = index;

      while (index < text.length && /[A-Za-z0-9_*/.]/.test(text[index]!)) {
        index += 1;
      }

      const path = text.slice(start, index).split("/").filter(Boolean);

      if (path.length === 0) {
        throw new FieldMaskError(`Invalid field selection ${fields}`);
      }

      let leaf: FieldMask | true = true;

      if (text[index] === "(") {
        index += 1;
        leaf = parseList();

        if (text[index] !== ")") {
          throw new FieldMaskError(`Invalid field selection ${fields}`);
        }

        index += 1;
      }

      let target = mask;

      for (const [position, name] of path.entries()) {
        if (position === path.length - 1) {
          const current = target.get(name);

          target.set(
            name,
            current instanceof Map && leaf instanceof Map
              ? new Map([...current, ...leaf])
              : leaf,
          );
        } else {
          let next = target.get(name);

          if (!(next instanceof Map)) {
            next = new Map();
            target.set(name, next);
          }

          target = next;
        }
      }

      if (text[index] === ",") {
        index += 1;
        continue;
      }

      return mask;
    }
  }

  const mask = parseList();

  if (index !== text.length) {
    throw new FieldMaskError(`Invalid field selection ${fields}`);
  }

  return mask;
}

export function applyFieldMask(
  value: unknown,
  mask: FieldMask | true,
): unknown {
  if (mask === true || mask.has("*")) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyFieldMask(item, mask));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};

  for (const [key, inner] of mask) {
    if (record[key] !== undefined) {
      picked[key] = applyFieldMask(record[key], inner);
    }
  }

  return picked;
}

/**
 * Sends a resource cut down to ?fields=, or to the default fields when the
 * request names none (null: everything, as the Directory API does).
 */
export function sendMasked(
  context: FakeRequest,
  value: unknown,
  defaultFields: string | null,
) {
  const fields = context.query.get("fields") ?? defaultFields;

  if (!fields) {
    sendJson(context.response, 200, value);
    return;
  }

  try {
    sendJson(
      context.response,
      200,
      applyFieldMask(value, parseFieldMask(fields)),
    );
  } catch (error) {
    sendGoogleError(
      context.response,
      400,
      "invalidParameter",
      error instanceof Error ? error.message : "Invalid field selection",
    );
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => HTML_ESCAPES[character] ?? character,
  );
}

/** Offset paging: the page token is where the next page starts. */
export function page<T>(
  items: T[],
  query: URLSearchParams,
  sizeParam: string,
  defaultSize: number,
  maxSize: number,
): { items: T[]; nextPageToken: string | undefined } {
  const requested = Number(query.get(sizeParam) ?? defaultSize);
  const size = Math.max(
    1,
    Math.min(Number.isFinite(requested) ? requested : defaultSize, maxSize),
  );
  const start = Math.max(0, Number(query.get("pageToken") ?? 0) || 0);
  const slice = items.slice(start, start + size);

  return {
    items: slice,
    nextPageToken:
      start + size < items.length ? String(start + size) : undefined,
  };
}
