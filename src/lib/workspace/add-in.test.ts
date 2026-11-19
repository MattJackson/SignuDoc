import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbExecutor } from "../db/connection.ts";
import { handleAddInRequest } from "./add-in.ts";
import {
  addInAddressProblem,
  addInDraftTitle,
  addInEndpointUrl,
  findAddInAccount,
} from "./add-in-support.ts";
import type { WorkspaceAddIn } from "./types.ts";

// The app's side of a workspace add-in, with no provider in it: the route
// answers 404 until an add-in is set up, passes each request to the one
// that is, and never shows its own failures to the caller.

function post(action: string) {
  return new Request(
    `https://sign.example.test/api/workspace/add-in/${action}`,
    {
      body: "{}",
      method: "POST",
    },
  );
}

test("with no add-in configured, every action is not there", async () => {
  for (const action of ["homepage", "gmail-message", "action"]) {
    const response = await handleAddInRequest(action, post(action), {
      getAddIn: async () => null,
    });

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("a configured add-in answers, for actions that look like one", async () => {
  const seen: string[] = [];
  const addIn: WorkspaceAddIn = {
    handle: async (action) => {
      seen.push(action);
      return Response.json({ ok: true });
    },
  };
  const ok = await handleAddInRequest("gmail-message", post("gmail-message"), {
    getAddIn: async () => addIn,
  });

  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  for (const action of ["..", "Admin", "a/b", "x".repeat(41), ""]) {
    const response = await handleAddInRequest(action, post("x"), {
      getAddIn: async () => addIn,
    });

    assert.equal(response.status, 404);
  }

  assert.deepEqual(seen, ["gmail-message"]);
});

test("a failure inside the add-in is a plain 500, logged", async () => {
  const logged: unknown[] = [];
  const response = await handleAddInRequest("homepage", post("homepage"), {
    getAddIn: async () => ({
      handle: async () => {
        throw new Error("secret detail");
      },
    }),
    logError: (error) => logged.push(error),
  });

  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret detail/);
  assert.equal(logged.length, 1);
});

test("the provider calls the add-in at a public HTTPS address", () => {
  assert.equal(
    addInEndpointUrl("https://sign.example.test/", "drive-items"),
    "https://sign.example.test/api/workspace/add-in/drive-items",
  );
  assert.equal(addInAddressProblem("https://sign.example.test"), null);

  for (const url of [
    "http://sign.example.test",
    "https://localhost:3000",
    "https://192.168.1.10",
    "https://signudoc.internal",
  ]) {
    assert.match(addInAddressProblem(url) ?? "", /public HTTPS/, url);
  }

  assert.match(addInAddressProblem(null) ?? "", /APP_URL/);
});

test("a draft's title comes from the document's name", () => {
  assert.equal(
    addInDraftTitle("Master_services  agreement.pdf"),
    "Master services agreement",
  );
  assert.equal(addInDraftTitle(".pdf"), "Untitled document");
});

type Row = { email: string; emailVerified: boolean; id: string; name: string };

function fakeDatabase(rows: Row[]) {
  const asked: unknown[][] = [];
  const database = {
    query: async (_text: string, values: unknown[]) => {
      asked.push(values);

      return {
        rows: rows.filter((row) => row.email.toLowerCase() === values[0]),
      };
    },
  } as unknown as DbExecutor;

  return { asked, database };
}

test("the account with the verified address is found, whatever its case", async () => {
  const { asked, database } = fakeDatabase([
    { email: "Sam@Example.com", emailVerified: true, id: "u-1", name: "" },
    { email: "new@example.com", emailVerified: false, id: "u-2", name: "New" },
  ]);

  assert.deepEqual(await findAddInAccount("SAM@example.com", database), {
    // With no name saved, the address stands in for one.
    account: { email: "Sam@Example.com", id: "u-1", name: "Sam@Example.com" },
    kind: "found",
  });
  assert.deepEqual(asked[0], ["sam@example.com"]);
  assert.deepEqual(await findAddInAccount("new@example.com", database), {
    kind: "unverified",
  });
  assert.deepEqual(await findAddInAccount("nobody@example.com", database), {
    kind: "no_account",
  });
});
