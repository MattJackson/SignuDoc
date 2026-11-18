import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GoogleAccessTokenRequest,
  GoogleCredentials,
} from "./credentials.ts";
import {
  buildUserQueries,
  createDirectoryClient,
  DirectoryError,
  managerFromRelations,
  readDirectoryConfig,
  type DirectoryConfig,
} from "./directory.ts";

function fakeCredentials() {
  const requests: GoogleAccessTokenRequest[] = [];
  const credentials: GoogleCredentials = {
    getAccessToken: async (request) => {
      requests.push(request);
      return "token-1";
    },
    getServiceAccountEmail: async () =>
      "signudoc@project.iam.gserviceaccount.com",
    source: "metadata",
  };

  return { credentials, requests };
}

function fakeFetch(answer: (url: URL) => { body?: unknown; status?: number }) {
  const urls: URL[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));

    urls.push(url);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer token-1",
    );

    const { body = {}, status = 200 } = answer(url);

    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }) as typeof fetch;

  return { fetchImpl, urls };
}

const adminRole: DirectoryConfig = {
  adminSubject: null,
  customer: "my_customer",
  enabled: true,
  enabledSource: "settings",
  mode: "admin-role",
};

test("the directory is off until it is turned on, and the environment wins", () => {
  assert.equal(readDirectoryConfig({}, null).enabled, false);
  assert.equal(
    readDirectoryConfig({}, { "google.directory": "on" }).enabled,
    true,
  );
  assert.equal(
    readDirectoryConfig(
      { GOOGLE_WORKSPACE_DIRECTORY: "off" },
      { "google.directory": "on" },
    ).enabled,
    false,
  );

  const delegated = readDirectoryConfig(
    { GOOGLE_WORKSPACE_ADMIN_SUBJECT: "admin@example.com" },
    { "google.adminSubject": "other@example.com" },
  );

  assert.equal(delegated.mode, "delegation");
  assert.equal(delegated.adminSubject, "admin@example.com");
  assert.equal(readDirectoryConfig({}, null).mode, "admin-role");
  assert.equal(readDirectoryConfig({}, null).customer, "my_customer");
});

test("a search term becomes prefix queries for active people only", () => {
  assert.deepEqual(buildUserQueries("  "), []);
  assert.deepEqual(buildUserQueries("Jo"), [
    "givenName:jo* isSuspended=false",
    "familyName:jo* isSuspended=false",
    "email:jo* isSuspended=false",
  ]);
  assert.deepEqual(buildUserQueries("jo@exa"), [
    "email:jo@exa* isSuspended=false",
  ]);
  assert.deepEqual(buildUserQueries("Jane Sm"), [
    "givenName:jane* familyName:sm* isSuspended=false",
  ]);
  // Quotes and other query syntax are dropped, not passed on.
  assert.deepEqual(buildUserQueries("x' OR name:'*"), [
    "givenName:x* familyName:or* isSuspended=false",
  ]);
});

test("search merges the answers, drops suspended people and caches", async () => {
  const { credentials, requests } = fakeCredentials();
  const { fetchImpl, urls } = fakeFetch((url) => {
    const query = url.searchParams.get("query") ?? "";

    if (query.startsWith("givenName")) {
      return {
        body: {
          users: [
            { name: { fullName: "Jo Park" }, primaryEmail: "Jo@example.com" },
            {
              name: { fullName: "Jo Gone" },
              primaryEmail: "gone@example.com",
              suspended: true,
            },
          ],
        },
      };
    }

    if (query.startsWith("email")) {
      return {
        body: {
          users: [
            { name: { fullName: "Jo Park" }, primaryEmail: "jo@example.com" },
            {
              name: { fullName: "Ann Jones" },
              primaryEmail: "jones@example.com",
            },
          ],
        },
      };
    }

    return { body: {} };
  });
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  const people = await client.searchUsers("jo");

  assert.deepEqual(people, [
    { email: "jones@example.com", name: "Ann Jones" },
    { email: "jo@example.com", name: "Jo Park" },
  ]);
  assert.equal(urls.length, 3);
  assert.equal(urls[0]!.searchParams.get("customer"), "my_customer");
  // As itself: no Workspace user to act as.
  assert.equal(requests[0]!.subject, undefined);
  assert.deepEqual(requests[0]!.scopes, [
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  ]);

  await client.searchUsers("jo");
  assert.equal(urls.length, 3);
});

test("delegation acts as the named administrator", async () => {
  const { credentials, requests } = fakeCredentials();
  const { fetchImpl, urls } = fakeFetch(() => ({ body: { isMember: true } }));
  const client = createDirectoryClient({
    config: {
      ...adminRole,
      adminSubject: "admin@example.com",
      mode: "delegation",
    },
    credentials,
    fetchImpl,
  });

  assert.equal(
    await client.isGroupMember("Admins@example.com", "pat@example.com"),
    true,
  );
  assert.equal(requests[0]!.subject, "admin@example.com");
  assert.equal(
    urls[0]!.pathname,
    "/admin/directory/v1/groups/admins%40example.com/hasMember/pat%40example.com",
  );
});

test("groups are listed across pages", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl, urls } = fakeFetch((url) =>
    url.searchParams.get("pageToken")
      ? { body: { groups: [{ email: "b@example.com", name: "B" }] } }
      : {
          body: {
            groups: [{ email: "A@example.com", name: "A" }],
            nextPageToken: "next",
          },
        },
  );
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.listUserGroups("pat@example.com"), [
    { email: "a@example.com", name: "A" },
    { email: "b@example.com", name: "B" },
  ]);
  assert.equal(urls.length, 2);
  assert.equal(urls[0]!.searchParams.get("userKey"), "pat@example.com");
});

test("errors carry Google's status and not its words", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl } = fakeFetch(() => ({
    body: { error: { message: "secret detail about the request" } },
    status: 403,
  }));
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  await assert.rejects(client.listUserGroups("pat@example.com"), (error) => {
    assert.ok(error instanceof DirectoryError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /secret detail/);
    return true;
  });
});

test("a user's entry gives their state and the manager relation", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl, urls } = fakeFetch((url) => {
    if (url.pathname.endsWith("/gone%40example.com")) {
      return {
        body: { error: { message: "Resource Not Found" } },
        status: 404,
      };
    }

    return {
      body: {
        name: { fullName: "Pat Lee" },
        primaryEmail: "Pat@example.com",
        relations: [
          { customType: "mentor", type: "custom", value: "sam@example.com" },
          { type: "manager", value: "Boss@Example.com" },
        ],
        suspended: true,
      },
    };
  });
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.getUser("PAT@example.com"), {
    archived: false,
    email: "pat@example.com",
    managerEmail: "boss@example.com",
    name: "Pat Lee",
    suspended: true,
  });
  assert.equal(
    urls[0]!.pathname,
    "/admin/directory/v1/users/pat%40example.com",
  );
  assert.equal(await client.getUser("gone@example.com"), null);
});

test("archived people are not suggested, and getUser says they are archived", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl } = fakeFetch((url) =>
    url.pathname === "/admin/directory/v1/users"
      ? {
          body: {
            users: [
              { name: { fullName: "Jo Park" }, primaryEmail: "jo@example.com" },
              {
                archived: true,
                name: { fullName: "Jo Archived" },
                primaryEmail: "archived@example.com",
              },
            ],
          },
        }
      : {
          body: {
            archived: true,
            name: { fullName: "Jo Archived" },
            primaryEmail: "archived@example.com",
          },
        },
  );
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.searchUsers("jo"), [
    { email: "jo@example.com", name: "Jo Park" },
  ]);
  assert.equal((await client.getUser("archived@example.com"))?.archived, true);
});

test("a failed lookup of a user is an error, never a missing user", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl } = fakeFetch(() => ({ status: 503 }));
  const client = createDirectoryClient({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  await assert.rejects(client.getUser("pat@example.com"), DirectoryError);
});

test("only a relation of type manager names the manager", () => {
  assert.equal(managerFromRelations(undefined), null);
  assert.equal(
    managerFromRelations([{ type: "assistant", value: "a@example.com" }]),
    null,
  );
  assert.equal(
    managerFromRelations([{ type: "manager", value: "not an address" }]),
    null,
  );
  assert.equal(
    managerFromRelations([{ type: "manager", value: " M@example.com " }]),
    "m@example.com",
  );
});
