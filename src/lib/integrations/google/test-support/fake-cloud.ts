import { createHash } from "node:crypto";

import {
  newId,
  page,
  readJsonBody,
  requireScope,
  sendGoogleError,
  sendJson,
  sendMasked,
  type FakeGoogleState,
  type FakeRequest,
  type StoredPermission,
} from "./fake-state.ts";

// The parts of Google Cloud and the Admin SDK that the automatic Google
// Workspace setup uses (integrations/google/workspace-setup.ts), for the
// fake Google server: Service Usage, API Keys, IAM service accounts, Cloud
// Resource Manager projects, Admin SDK customers, roles and role
// assignments, and members of Shared Drives. Long-running operations are
// reported not done when started and done on the first look after.

const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const ROLE_MANAGEMENT =
  "https://www.googleapis.com/auth/admin.directory.rolemanagement";
const CUSTOMER_SCOPES = new Set([
  "https://www.googleapis.com/auth/admin.directory.customer",
  "https://www.googleapis.com/auth/admin.directory.customer.readonly",
]);
const DRIVE = "https://www.googleapis.com/auth/drive";

/** The privileges Admin SDK lists, nested the way Google nests them. */
export const FAKE_ADMIN_SERVICE_ID = "00haapch16h1ysv";

export type FakeApiKey = {
  displayName: string;
  keyString: string;
  name: string;
  restrictions: Record<string, unknown>;
};

export type FakeCloudState = {
  apiKeys: Map<string, FakeApiKey>;
  customerId: string;
  /** Users the fake treats as having no rights on the Cloud project. */
  deniedProjectUsers: Set<string>;
  /** Members of each Shared Drive, by drive ID. */
  drivePermissions: Map<string, StoredPermission[]>;
  enabledServices: Set<string>;
  /** Cloud Resource Manager leaves the project number out when true. */
  hideProjectNumber: boolean;
  operations: Map<string, { done: boolean; response: unknown }>;
  projectNumber: string;
  roleAssignments: Array<{
    assignedTo: string;
    roleAssignmentId: string;
    roleId: string;
    scopeType: string;
  }>;
  roles: Map<
    string,
    {
      roleId: string;
      roleName: string;
      rolePrivileges: Array<{ privilegeName: string; serviceId: string }>;
    }
  >;
  /**
   * How many more times the Admin SDK or the API Keys API answers that it
   * is still turned off, as Google does for a while after it is turned on.
   * Infinity: it never comes on.
   */
  slowServices: Map<string, number>;
};

const cloudStates = new WeakMap<FakeGoogleState, FakeCloudState>();

/** What the fake Cloud holds, made the first time it is asked for. */
export function cloudState(state: FakeGoogleState): FakeCloudState {
  let cloud = cloudStates.get(state);

  if (!cloud) {
    cloud = {
      apiKeys: new Map(),
      customerId: "C0fake123",
      deniedProjectUsers: new Set(),
      drivePermissions: new Map(),
      enabledServices: new Set(["serviceusage.googleapis.com"]),
      hideProjectNumber: false,
      operations: new Map(),
      projectNumber: "123456789012",
      roleAssignments: [],
      roles: new Map(),
      slowServices: new Map(),
    };
    cloudStates.set(state, cloud);
  }

  return cloud;
}

/** A service account's numeric unique ID, the same every time. */
export function fakeServiceAccountUniqueId(email: string): string {
  const digits = BigInt(
    `0x${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 15)}`,
  ).toString();

  return `1${digits.padStart(20, "0").slice(0, 20)}`;
}

function startOperation(
  cloud: FakeCloudState,
  prefix: string,
  response: unknown,
) {
  const name = `operations/${prefix}.${String(cloud.operations.size + 1)}`;

  cloud.operations.set(name, { done: false, response });

  return { done: false, name };
}

function projectAllowed(context: FakeRequest, cloud: FakeCloudState): boolean {
  if (!requireScope(context, (scope) => scope === CLOUD_PLATFORM)) {
    return false;
  }

  if (context.token?.user && cloud.deniedProjectUsers.has(context.token.user)) {
    sendGoogleError(
      context.response,
      403,
      "forbidden",
      "The caller does not have permission",
    );
    return false;
  }

  return true;
}

function handleServiceUsage(
  context: FakeRequest,
  cloud: FakeCloudState,
): boolean {
  const { method, path, response } = context;
  const batchGet = /^\/v1\/projects\/([^/]+)\/services:batchGet$/.exec(path);
  const batchEnable = /^\/v1\/projects\/([^/]+)\/services:batchEnable$/.exec(
    path,
  );
  const operation = /^\/v1\/(operations\/[^/]+)$/.exec(path);

  if (batchGet && method === "GET") {
    if (projectAllowed(context, cloud)) {
      sendJson(response, 200, {
        services: context.query.getAll("names").map((name) => {
          const service = name.split("/").pop() ?? "";

          return {
            config: { name: service },
            name,
            state: cloud.enabledServices.has(service) ? "ENABLED" : "DISABLED",
          };
        }),
      });
    }

    return true;
  }

  if (batchEnable && method === "POST") {
    if (projectAllowed(context, cloud)) {
      const input = readJsonBody(context.body) ?? {};
      const ids = Array.isArray(input.serviceIds)
        ? input.serviceIds.filter((id): id is string => typeof id === "string")
        : [];

      for (const id of ids) {
        cloud.enabledServices.add(id);
      }

      sendJson(
        response,
        200,
        startOperation(cloud, "acf", {
          services: ids.map((id) => ({ name: id })),
        }),
      );
    }

    return true;
  }

  if (
    operation &&
    method === "GET" &&
    operation[1]!.startsWith("operations/acf")
  ) {
    return sendOperation(context, cloud, operation[1]!);
  }

  return false;
}

function sendOperation(
  context: FakeRequest,
  cloud: FakeCloudState,
  name: string,
): boolean {
  if (!requireScope(context, (scope) => scope === CLOUD_PLATFORM)) {
    return true;
  }

  const found = cloud.operations.get(name);

  if (!found) {
    sendGoogleError(context.response, 404, "notFound", "Operation not found.");
    return true;
  }

  found.done = true;
  sendJson(context.response, 200, {
    done: true,
    name,
    response: found.response,
  });
  return true;
}

function handleApiKeys(context: FakeRequest, cloud: FakeCloudState): boolean {
  const { method, path, response } = context;
  const keys = /^\/v2\/projects\/([^/]+)\/locations\/global\/keys$/.exec(path);
  const key =
    /^\/v2\/(projects\/[^/]+\/locations\/global\/keys\/[^/]+?)(\/keyString)?$/.exec(
      path,
    );
  const operation = /^\/v2\/(operations\/[^/]+)$/.exec(path);

  if (operation && method === "GET") {
    return sendOperation(context, cloud, operation[1]!);
  }

  if (!keys && !key) {
    return false;
  }

  if (!projectAllowed(context, cloud)) {
    return true;
  }

  if (!cloud.enabledServices.has("apikeys.googleapis.com")) {
    sendJson(response, 403, {
      error: {
        code: 403,
        details: [{ reason: "SERVICE_DISABLED" }],
        message:
          "API Keys API has not been used in this project before or it is disabled.",
        status: "PERMISSION_DENIED",
      },
    });
    return true;
  }

  if (keys && method === "GET") {
    const result = page(
      Array.from(cloud.apiKeys.values()),
      context.query,
      "pageSize",
      300,
      300,
    );

    sendJson(response, 200, {
      keys: result.items.map((stored) => ({
        displayName: stored.displayName,
        name: stored.name,
        restrictions: stored.restrictions,
      })),
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    });
    return true;
  }

  if (keys && method === "POST") {
    const input = readJsonBody(context.body) ?? {};

    // The API Keys API holds display names to 63 characters.
    if (
      typeof input.displayName === "string" &&
      input.displayName.length > 63
    ) {
      sendGoogleError(
        response,
        400,
        "invalidArgument",
        "Display name must be 63 characters or fewer.",
      );
      return true;
    }

    const name = `projects/${cloud.projectNumber}/locations/global/keys/${newId(context.state, "key")}`;
    const stored: FakeApiKey = {
      displayName:
        typeof input.displayName === "string" ? input.displayName : "",
      keyString: `AIzaFake${newId(context.state, "")}`,
      name,
      restrictions:
        typeof input.restrictions === "object" && input.restrictions !== null
          ? (input.restrictions as Record<string, unknown>)
          : {},
    };

    cloud.apiKeys.set(name, stored);
    sendJson(
      response,
      200,
      startOperation(cloud, "akmf", {
        displayName: stored.displayName,
        name,
        restrictions: stored.restrictions,
      }),
    );
    return true;
  }

  const stored = key ? cloud.apiKeys.get(key[1]!) : undefined;

  if (!stored) {
    sendGoogleError(response, 404, "notFound", "Key not found.");
    return true;
  }

  if (key?.[2] && method === "GET") {
    sendJson(response, 200, { keyString: stored.keyString });
    return true;
  }

  if (!key?.[2] && method === "PATCH") {
    const input = readJsonBody(context.body) ?? {};

    if (typeof input.restrictions === "object" && input.restrictions !== null) {
      stored.restrictions = input.restrictions as Record<string, unknown>;
    }

    sendJson(
      response,
      200,
      startOperation(cloud, "akmf", { name: stored.name }),
    );
    return true;
  }

  sendGoogleError(response, 405, "methodNotAllowed", "Not allowed.");
  return true;
}

function handleProjects(context: FakeRequest, cloud: FakeCloudState): boolean {
  const { method, path, response } = context;
  const account = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+)$/.exec(path);
  const project = /^\/v1\/projects\/([^/:]+)$/.exec(path);

  if (account && method === "GET") {
    if (projectAllowed(context, cloud)) {
      const email = decodeURIComponent(account[1]!).toLowerCase();

      sendJson(response, 200, {
        email,
        name: `projects/-/serviceAccounts/${email}`,
        oauth2ClientId: fakeServiceAccountUniqueId(email),
        uniqueId: fakeServiceAccountUniqueId(email),
      });
    }

    return true;
  }

  if (project && method === "GET") {
    if (projectAllowed(context, cloud)) {
      sendJson(response, 200, {
        projectId: decodeURIComponent(project[1]!),
        ...(cloud.hideProjectNumber
          ? {}
          : { projectNumber: cloud.projectNumber }),
      });
    }

    return true;
  }

  return false;
}

function adminDisabled(context: FakeRequest, cloud: FakeCloudState): boolean {
  if (cloud.enabledServices.has("admin.googleapis.com")) {
    return false;
  }

  sendJson(context.response, 403, {
    error: {
      code: 403,
      errors: [{ reason: "accessNotConfigured" }],
      message:
        "Admin SDK API has not been used in this project before or it is disabled.",
    },
  });
  return true;
}

function handleAdmin(context: FakeRequest, cloud: FakeCloudState): boolean {
  const { method, path, query, response } = context;
  const customerPath = /^\/admin\/directory\/v1\/customers\/([^/]+)$/.exec(
    path,
  );
  const rolesPath =
    /^\/admin\/directory\/v1\/customer\/([^/]+)\/(roles|roleassignments)(\/ALL\/privileges)?$/.exec(
      path,
    );

  if (customerPath && method === "GET") {
    if (
      requireScope(context, (scope) => CUSTOMER_SCOPES.has(scope)) &&
      !adminDisabled(context, cloud)
    ) {
      if (!isSuperAdmin(context)) {
        sendGoogleError(
          response,
          403,
          "forbidden",
          "Not Authorized to access this resource/api",
        );
        return true;
      }

      sendJson(response, 200, {
        customerDomain: "example.test",
        id: cloud.customerId,
        kind: "admin#directory#customer",
      });
    }

    return true;
  }

  if (!rolesPath) {
    return false;
  }

  if (
    !requireScope(context, (scope) => scope === ROLE_MANAGEMENT) ||
    adminDisabled(context, cloud)
  ) {
    return true;
  }

  if (!isSuperAdmin(context)) {
    sendGoogleError(
      response,
      403,
      "forbidden",
      "Not Authorized to access this resource/api",
    );
    return true;
  }

  const [, , kind, privileges] = rolesPath;

  if (kind === "roles" && privileges && method === "GET") {
    sendJson(response, 200, {
      items: [
        {
          childPrivileges: [
            {
              childPrivileges: [
                {
                  privilegeName: "USERS_RETRIEVE",
                  serviceId: FAKE_ADMIN_SERVICE_ID,
                },
                {
                  privilegeName: "USERS_UPDATE",
                  serviceId: FAKE_ADMIN_SERVICE_ID,
                },
              ],
              privilegeName: "USERS_ALL",
              serviceId: FAKE_ADMIN_SERVICE_ID,
            },
            {
              childPrivileges: [
                {
                  privilegeName: "GROUPS_RETRIEVE",
                  serviceId: FAKE_ADMIN_SERVICE_ID,
                },
              ],
              privilegeName: "GROUPS_ALL",
              serviceId: FAKE_ADMIN_SERVICE_ID,
            },
          ],
          privilegeName: "ADMIN_APIS_ALL",
          serviceId: FAKE_ADMIN_SERVICE_ID,
        },
      ],
      kind: "admin#directory#privileges",
    });
    return true;
  }

  if (kind === "roles" && method === "GET") {
    const result = page(
      Array.from(cloud.roles.values()),
      query,
      "maxResults",
      100,
      100,
    );

    sendJson(response, 200, {
      items: result.items,
      kind: "admin#directory#roles",
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    });
    return true;
  }

  if (kind === "roles" && method === "POST") {
    const input = readJsonBody(context.body) ?? {};
    const role = {
      roleId: newId(context.state, ""),
      roleName: typeof input.roleName === "string" ? input.roleName : "",
      rolePrivileges: Array.isArray(input.rolePrivileges)
        ? (input.rolePrivileges as Array<{
            privilegeName: string;
            serviceId: string;
          }>)
        : [],
    };

    if (
      Array.from(cloud.roles.values()).some(
        (existing) => existing.roleName === role.roleName,
      )
    ) {
      sendGoogleError(response, 409, "duplicate", "Entity already exists.");
      return true;
    }

    cloud.roles.set(role.roleId, role);
    sendJson(response, 200, role);
    return true;
  }

  if (kind === "roleassignments" && method === "GET") {
    const roleId = query.get("roleId");
    const result = page(
      cloud.roleAssignments.filter(
        (assignment) => !roleId || assignment.roleId === roleId,
      ),
      query,
      "maxResults",
      100,
      200,
    );

    sendJson(response, 200, {
      items: result.items,
      kind: "admin#directory#roleAssignments",
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    });
    return true;
  }

  if (kind === "roleassignments" && method === "POST") {
    const input = readJsonBody(context.body) ?? {};
    const assignment = {
      assignedTo: String(input.assignedTo ?? ""),
      roleAssignmentId: newId(context.state, ""),
      roleId: String(input.roleId ?? ""),
      scopeType: String(input.scopeType ?? ""),
    };

    if (!cloud.roles.has(assignment.roleId)) {
      sendGoogleError(response, 404, "notFound", "Role not found.");
      return true;
    }

    cloud.roleAssignments.push(assignment);
    sendJson(response, 200, assignment);
    return true;
  }

  sendGoogleError(response, 405, "methodNotAllowed", "Not allowed.");
  return true;
}

function isSuperAdmin(context: FakeRequest): boolean {
  const email = context.token?.user;

  return email ? context.state.users.get(email)?.isAdmin === true : false;
}

/** Members of a Shared Drive, asked through the files permissions API. */
function handleDriveMembers(
  context: FakeRequest,
  cloud: FakeCloudState,
): boolean {
  const match = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(context.path);
  const driveId = match ? decodeURIComponent(match[1]!) : null;

  if (!driveId || !context.state.drives.has(driveId)) {
    return false;
  }

  if (!requireScope(context, (scope) => scope === DRIVE)) {
    return true;
  }

  const members = cloud.drivePermissions.get(driveId) ?? [];

  cloud.drivePermissions.set(driveId, members);

  if (context.method === "GET") {
    const result = page(members, context.query, "pageSize", 100, 100);

    // Only the fields asked for come back, so a mask without
    // nextPageToken hides that there is more.
    sendMasked(
      context,
      {
        kind: "drive#permissionList",
        permissions: result.items,
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      },
      null,
    );
    return true;
  }

  if (context.method === "POST") {
    const input = readJsonBody(context.body) ?? {};
    const permission: StoredPermission = {
      emailAddress:
        typeof input.emailAddress === "string"
          ? input.emailAddress.toLowerCase()
          : undefined,
      id: newId(context.state, "perm"),
      role: typeof input.role === "string" ? input.role : "reader",
      type: typeof input.type === "string" ? input.type : "user",
    };

    members.push(permission);
    sendJson(context.response, 200, {
      kind: "drive#permission",
      ...permission,
    });
    return true;
  }

  sendGoogleError(context.response, 405, "methodNotAllowed", "Not allowed.");
  return true;
}

const SLOW_PATHS: Array<[RegExp, string]> = [
  [/^\/admin\/directory\/v1\//, "admin.googleapis.com"],
  [/^\/v2\/projects\/[^/]+\/locations\/global\/keys/, "apikeys.googleapis.com"],
];

/** Answers "still turned off" for a service set as slow. */
function answerSlow(context: FakeRequest, cloud: FakeCloudState): boolean {
  for (const [pattern, service] of SLOW_PATHS) {
    const left = cloud.slowServices.get(service) ?? 0;

    if (!pattern.test(context.path) || left <= 0) {
      continue;
    }

    cloud.slowServices.set(service, left - 1);
    sendJson(context.response, 403, {
      error: {
        code: 403,
        details: [{ reason: "SERVICE_DISABLED" }],
        errors: [{ reason: "accessNotConfigured" }],
        message: `${service} has not been used in this project before or it is disabled.`,
        status: "PERMISSION_DENIED",
      },
    });
    return true;
  }

  return false;
}

/** Handles a request for one of the parts above. False when it is not one. */
export function handleCloud(context: FakeRequest): boolean {
  const cloud = cloudState(context.state);

  return (
    answerSlow(context, cloud) ||
    handleServiceUsage(context, cloud) ||
    handleApiKeys(context, cloud) ||
    handleProjects(context, cloud) ||
    handleAdmin(context, cloud) ||
    handleDriveMembers(context, cloud)
  );
}
