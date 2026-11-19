import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GoogleAccessTokenRequest,
  GoogleCredentials,
} from "./credentials.ts";
import { DirectoryError } from "../../types.ts";
import {
  buildUserQueries,
  createGoogleDirectory,
  managerFromRelations,
  needsCustomerId,
  readGoogleDirectoryConfig,
  type GoogleDirectoryConfig,
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

const adminRole: GoogleDirectoryConfig = {
  adminSubject: null,
  customer: "my_customer",
  mode: "admin-role",
};

test("the access mode follows the admin subject, and the environment wins", () => {
  const delegated = readGoogleDirectoryConfig(
    { "google.adminSubject": "other@example.com" },
    { GOOGLE_WORKSPACE_ADMIN_SUBJECT: "Admin@Example.com" },
  );

  assert.equal(delegated.mode, "delegation");
  assert.equal(delegated.adminSubject, "admin@example.com");

  const own = readGoogleDirectoryConfig(null, {});

  assert.equal(own.mode, "admin-role");
  assert.equal(own.customer, "my_customer");
  // With the admin role, the customer ID has to be entered.
  assert.equal(needsCustomerId(own), true);
  assert.equal(
    readGoogleDirectoryConfig({ "google.customerId": "C01ab2cd3" }, {})
      .customer,
    "C01ab2cd3",
  );
  assert.equal(needsCustomerId(delegated), false);
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
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  const people = await client.searchPeople("jo");

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

  await client.searchPeople("jo");
  assert.equal(urls.length, 3);
});

test("delegation acts as the named administrator", async () => {
  const { credentials, requests } = fakeCredentials();
  const { fetchImpl, urls } = fakeFetch(() => ({ body: { isMember: true } }));
  const client = createGoogleDirectory({
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
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.listPersonGroups("pat@example.com"), [
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
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  await assert.rejects(client.listPersonGroups("pat@example.com"), (error) => {
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
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.getPerson("PAT@example.com"), {
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
  assert.equal(await client.getPerson("gone@example.com"), null);
});

test("archived people are not suggested, and getPerson says they are archived", async () => {
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
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  assert.deepEqual(await client.searchPeople("jo"), [
    { email: "jo@example.com", name: "Jo Park" },
  ]);
  assert.equal(
    (await client.getPerson("archived@example.com"))?.archived,
    true,
  );
});

test("a failed lookup of a user is an error, never a missing user", async () => {
  const { credentials } = fakeCredentials();
  const { fetchImpl } = fakeFetch(() => ({ status: 503 }));
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl,
  });

  await assert.rejects(client.getPerson("pat@example.com"), DirectoryError);
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

test("a directory request with no answer is given up on", async () => {
  const { credentials } = fakeCredentials();
  const client = createGoogleDirectory({
    config: adminRole,
    credentials,
    fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      })) as typeof fetch,
    timeoutMs: 20,
  });
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Still waiting after the deadline."));
    }, 2000);
  });

  await assert.rejects(
    Promise.race([client.getPerson("pat@example.com"), hung]).finally(() => {
      clearTimeout(timer);
    }),
    DirectoryError,
  );
});
