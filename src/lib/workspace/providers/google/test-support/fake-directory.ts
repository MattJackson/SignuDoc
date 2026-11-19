import {
  findGroup,
  findUser,
  inDirectory,
  page,
  requireScope,
  sendGoogleError,
  sendMasked,
  type FakeGoogleState,
  type FakeRequest,
  type StoredGroup,
  type StoredUser,
} from "./fake-state.ts";

// The part of the Admin SDK Directory API the app reads: users (search,
// one user with their manager in relations), groups, their members, and
// hasMember through nested groups. The search language is the documented
// one, reduced to the fields a client is likely to use; anything else is
// answered with 400 so a test notices instead of passing on a guess.
// https://developers.google.com/workspace/admin/directory/reference/rest

const PREFIX = "/admin/directory/v1";
const USER_SCOPES = new Set([
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
]);
const GROUP_SCOPES = new Set([
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
]);

const CUSTOMER_ID = "C0fake000";

export function userResource(user: StoredUser) {
  return {
    agreedToTerms: true,
    archived: user.archived,
    customerId: CUSTOMER_ID,
    emails: [{ address: user.email, primary: true }],
    id: user.id,
    isAdmin: user.isAdmin,
    isMailboxSetup: true,
    kind: "admin#directory#user",
    name: {
      familyName: user.familyName,
      fullName: `${user.givenName} ${user.familyName}`.trim(),
      givenName: user.givenName,
    },
    orgUnitPath: user.orgUnitPath,
    primaryEmail: user.email,
    suspended: user.suspended,
    ...(user.title || user.department
      ? {
          organizations: [
            {
              primary: true,
              ...(user.department ? { department: user.department } : {}),
              ...(user.title ? { title: user.title } : {}),
            },
          ],
        }
      : {}),
    ...(user.manager
      ? { relations: [{ type: "manager", value: user.manager }] }
      : {}),
  };
}

function groupResource(group: StoredGroup) {
  return {
    adminCreated: true,
    description: group.description,
    directMembersCount: String(group.members.length),
    email: group.email,
    id: group.id,
    kind: "admin#directory#group",
    name: group.name,
  };
}

function memberResource(state: FakeGoogleState, email: string, role: string) {
  const group = state.groups.get(email);
  const user = state.users.get(email);

  return {
    email,
    id: group?.id ?? user?.id ?? email,
    kind: "admin#directory#member",
    role,
    status: user?.suspended ? "SUSPENDED" : "ACTIVE",
    type: group ? "GROUP" : "USER",
  };
}

export class DirectoryQueryError extends Error {}

/** Splits a query on spaces that are not inside quotes. */
function splitQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const character of query) {
    if (quote) {
      current += character;

      if (character === quote) {
        quote = null;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
      }

      current = "";
    } else {
      current += character;
    }
  }

  if (quote) {
    throw new DirectoryQueryError(`Invalid query: unclosed quote in ${query}`);
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** Whether a text matches a value from the query, "Jane*" being a prefix. */
function textMatches(text: string, value: string, operator: string): boolean {
  const haystack = text.toLowerCase();
  const prefix = value.endsWith("*");
  const needle = (prefix ? value.slice(0, -1) : value).toLowerCase();

  if (operator === "=") {
    return haystack === needle;
  }

  const words = [haystack, ...haystack.split(/\s+/)];

  return words.some((word) =>
    prefix ? word.startsWith(needle) : word === needle,
  );
}

function managerChain(state: FakeGoogleState, user: StoredUser): string[] {
  const chain: string[] = [];
  let next = user.manager;

  while (next && !chain.includes(next)) {
    chain.push(next);
    next = state.users.get(next)?.manager ?? null;
  }

  return chain;
}

/**
 * A matcher for a users.list query.
 * https://developers.google.com/workspace/admin/directory/v1/guides/search-users
 */
export function compileUserQuery(
  state: FakeGoogleState,
  query: string,
): (user: StoredUser) => boolean {
  const tests = splitQuery(query).map((token) => {
    const match = /^([A-Za-z.]+)(:|=)(.+)$/.exec(token);

    if (!match) {
      // A bare word is looked for in names and addresses.
      const value = `${unquote(token)}*`;

      return (user: StoredUser) =>
        textMatches(user.givenName, value, ":") ||
        textMatches(user.familyName, value, ":") ||
        textMatches(user.email, value, ":");
    }

    const [, field, operator, rawValue] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    const value = unquote(rawValue);
    const bool = value.toLowerCase() === "true";

    switch (field) {
      case "givenName":
        return (user: StoredUser) =>
          textMatches(user.givenName, value, operator);
      case "familyName":
        return (user: StoredUser) =>
          textMatches(user.familyName, value, operator);
      case "name":
        return (user: StoredUser) =>
          textMatches(`${user.givenName} ${user.familyName}`, value, operator);
      case "email":
        return (user: StoredUser) =>
          value.endsWith("*")
            ? user.email.startsWith(value.slice(0, -1).toLowerCase())
            : user.email === value.toLowerCase();
      case "isSuspended":
        return (user: StoredUser) => user.suspended === bool;
      case "isArchived":
        return (user: StoredUser) => user.archived === bool;
      case "isAdmin":
        return (user: StoredUser) => user.isAdmin === bool;
      case "orgUnitPath":
        return (user: StoredUser) =>
          user.orgUnitPath.toLowerCase() === value.toLowerCase();
      case "directManager":
        return (user: StoredUser) => user.manager === value.toLowerCase();
      case "manager":
        return (user: StoredUser) =>
          managerChain(state, user).includes(value.toLowerCase());
      default:
        throw new DirectoryQueryError(
          `Invalid Input: the fake directory does not search on ${field}`,
        );
    }
  });

  return (user) => tests.every((check) => check(user));
}

function sortUsers(users: StoredUser[], query: URLSearchParams) {
  const orderBy = query.get("orderBy");
  const key = (user: StoredUser) =>
    orderBy === "givenName"
      ? user.givenName
      : orderBy === "familyName"
        ? user.familyName
        : user.email;
  const sorted = [...users].sort((a, b) =>
    key(a).toLowerCase().localeCompare(key(b).toLowerCase()),
  );

  return query.get("sortOrder")?.toUpperCase() === "DESCENDING"
    ? sorted.reverse()
    : sorted;
}

/** Whether the address is in the group, directly or through nested groups. */
export function hasMember(
  state: FakeGoogleState,
  group: StoredGroup,
  email: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(group.email)) {
    return false;
  }

  seen.add(group.email);

  return group.members.some((member) => {
    if (member.email === email) {
      return true;
    }

    const nested = state.groups.get(member.email);

    return nested ? hasMember(state, nested, email, seen) : false;
  });
}

function derivedMembers(
  state: FakeGoogleState,
  group: StoredGroup,
  seen = new Set<string>(),
): Array<{ email: string; role: string }> {
  if (seen.has(group.email)) {
    return [];
  }

  seen.add(group.email);

  const members: Array<{ email: string; role: string }> = [];

  for (const member of group.members) {
    const nested = state.groups.get(member.email);

    members.push(member);

    if (nested) {
      members.push(...derivedMembers(state, nested, seen));
    }
  }

  return members.filter(
    (member, index) =>
      members.findIndex((other) => other.email === member.email) === index,
  );
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Handles a Directory API request. False when the path is not one. */
export function handleDirectory(context: FakeRequest): boolean {
  if (!context.path.startsWith(`${PREFIX}/`)) {
    return false;
  }

  const { query, response, state } = context;
  const parts = context.path
    .slice(PREFIX.length + 1)
    .split("/")
    .map(decode);

  if (context.method !== "GET") {
    sendGoogleError(
      response,
      405,
      "methodNotAllowed",
      "The fake directory is read-only.",
    );
    return true;
  }

  if (parts[0] === "users") {
    if (!requireScope(context, (scope) => USER_SCOPES.has(scope))) {
      return true;
    }

    if (parts.length === 1) {
      const customer = query.get("customer");
      const domain = query.get("domain")?.toLowerCase();

      if (!customer && !domain) {
        sendGoogleError(response, 400, "badRequest", "Bad Request");
        return true;
      }

      let matcher: (user: StoredUser) => boolean;

      try {
        matcher = compileUserQuery(state, query.get("query") ?? "");
      } catch (error) {
        sendGoogleError(
          response,
          400,
          "invalid",
          error instanceof Error ? error.message : "Invalid Input",
        );
        return true;
      }

      const users = sortUsers(
        Array.from(state.users.values()).filter(
          (user) =>
            inDirectory(state, user) &&
            (!domain || user.email.endsWith(`@${domain}`)) &&
            matcher(user),
        ),
        query,
      );
      const result = page(users, query, "maxResults", 100, 500);

      sendMasked(
        context,
        {
          kind: "admin#directory#users",
          ...(result.items.length > 0
            ? { users: result.items.map(userResource) }
            : {}),
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        null,
      );
      return true;
    }

    const user = parts.length === 2 ? findUser(state, parts[1]!) : null;

    if (!user || !inDirectory(state, user)) {
      sendGoogleError(response, 404, "notFound", "Resource Not Found: userKey");
      return true;
    }

    sendMasked(context, userResource(user), null);
    return true;
  }

  if (parts[0] === "groups") {
    if (!requireScope(context, (scope) => GROUP_SCOPES.has(scope))) {
      return true;
    }

    if (parts.length === 1) {
      const userKey = query.get("userKey")?.toLowerCase();
      const domain = query.get("domain")?.toLowerCase();

      if (!userKey && !query.get("customer") && !domain) {
        sendGoogleError(response, 400, "badRequest", "Bad Request");
        return true;
      }

      const groups = Array.from(state.groups.values())
        .filter(
          (group) =>
            (!userKey ||
              group.members.some((member) => member.email === userKey)) &&
            (!domain || group.email.endsWith(`@${domain}`)),
        )
        .sort((a, b) => a.email.localeCompare(b.email));
      const result = page(groups, query, "maxResults", 200, 200);

      sendMasked(
        context,
        {
          kind: "admin#directory#groups",
          ...(result.items.length > 0
            ? { groups: result.items.map(groupResource) }
            : {}),
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        null,
      );
      return true;
    }

    const group = findGroup(state, parts[1]!);

    if (!group) {
      sendGoogleError(
        response,
        404,
        "notFound",
        "Resource Not Found: groupKey",
      );
      return true;
    }

    if (parts.length === 2) {
      sendMasked(context, groupResource(group), null);
      return true;
    }

    if (parts[2] === "hasMember" && parts.length === 4) {
      sendMasked(
        context,
        { isMember: hasMember(state, group, parts[3]!.toLowerCase()) },
        null,
      );
      return true;
    }

    if (parts[2] === "members") {
      if (parts.length === 4) {
        const email = parts[3]!.toLowerCase();
        const member = group.members.find((item) => item.email === email);

        if (!member) {
          sendGoogleError(
            response,
            404,
            "notFound",
            "Resource Not Found: memberKey",
          );
          return true;
        }

        sendMasked(
          context,
          memberResource(state, member.email, member.role),
          null,
        );
        return true;
      }

      const roles = query
        .get("roles")
        ?.split(",")
        .map((role) => role.trim().toUpperCase());
      const listed: Array<{ email: string; role: string }> =
        query.get("includeDerivedMembership") === "true"
          ? derivedMembers(state, group).filter(
              (member) => !state.groups.has(member.email),
            )
          : group.members;
      const members = listed.filter(
        (member) => !roles || roles.includes(member.role),
      );
      const result = page(members, query, "maxResults", 200, 200);

      sendMasked(
        context,
        {
          kind: "admin#directory#members",
          ...(result.items.length > 0
            ? {
                members: result.items.map((member) =>
                  memberResource(state, member.email, member.role),
                ),
              }
            : {}),
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        null,
      );
      return true;
    }
  }

  sendGoogleError(
    response,
    404,
    "notFound",
    `The fake directory has no ${context.path}.`,
  );
  return true;
}
