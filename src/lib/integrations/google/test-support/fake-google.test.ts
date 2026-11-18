import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  type JsonWebKey,
} from "node:crypto";
import { after, before, test } from "node:test";

import { createGoogleCredentials, GOOGLE_SCOPES } from "../credentials.ts";
import { createDirectoryClient, readDirectoryConfig } from "../directory.ts";
import { GOOGLE_APPS, ROOT_FOLDER_ID } from "./fake-drive.ts";
import {
  createFakeServiceAccountKey,
  FAKE_GOOGLE_CLIENT,
  FAKE_GOOGLE_ISSUER,
  startFakeGoogle,
  type FakeGoogle,
} from "./fake-google.ts";

// The fake Google server, driven through the app's own Google clients
// where there is one, so the fake and the clients are held to each other.

const key = createFakeServiceAccountKey();
let google: FakeGoogle;

before(async () => {
  google = await startFakeGoogle({
    directoryDomains: ["acme.example"],
    drives: [{ id: "0AFakeLegal", name: "Legal" }],
    groups: [
      {
        email: "signudoc-admins@acme.example",
        members: ["dana@acme.example", "leads@acme.example"],
        name: "SignuDoc admins",
      },
      { email: "leads@acme.example", members: ["sam@acme.example"] },
    ],
    serviceAccounts: [key],
    users: [
      {
        email: "dana@acme.example",
        familyName: "Admin",
        givenName: "Dana",
      },
      {
        email: "sam@acme.example",
        familyName: "Sender",
        givenName: "Sam",
        manager: "dana@acme.example",
        title: "Paralegal",
      },
      {
        email: "daniel@acme.example",
        familyName: "Diaz",
        givenName: "Daniel",
        suspended: true,
      },
      { email: "olga@other.example", familyName: "Other", givenName: "Olga" },
      {
        email: "pat@gmail.example",
        familyName: "Personal",
        givenName: "Pat",
        hd: null,
      },
    ],
  });
});

after(async () => {
  await google.close();
});

function env() {
  return { ...google.env, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key) };
}

async function signIn(email: string, nonce: string) {
  const verifier = randomBytes(32).toString("base64url");
  const discovery = (await (
    await fetch(`${google.url}/.well-known/openid-configuration`)
  ).json()) as Record<string, string>;
  const authorize = new URL(discovery.authorization_endpoint!);

  authorize.search = new URLSearchParams({
    client_id: FAKE_GOOGLE_CLIENT.id,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    hd: "acme.example",
    login_hint: email,
    nonce,
    redirect_uri: "http://localhost:3000/api/auth/callback/sso",
    response_type: "code",
    scope: "openid email profile",
    state: "the-state",
  }).toString();

  const redirect = await fetch(authorize, { redirect: "manual" });
  const back = new URL(redirect.headers.get("location") ?? "");

  assert.equal(redirect.status, 302);
  assert.equal(back.searchParams.get("state"), "the-state");

  const token = await fetch(discovery.token_endpoint!, {
    body: new URLSearchParams({
      client_id: FAKE_GOOGLE_CLIENT.id,
      client_secret: FAKE_GOOGLE_CLIENT.secret,
      code: back.searchParams.get("code") ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:3000/api/auth/callback/sso",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  assert.equal(token.status, 200);

  const tokens = (await token.json()) as { id_token: string };
  const jwks = (await (await fetch(discovery.jwks_uri!)).json()) as {
    keys: JsonWebKey[];
  };
  const [header, payload, signature] = tokens.id_token.split(".") as [
    string,
    string,
    string,
  ];
  const verifierKey = createPublicKey({ format: "jwk", key: jwks.keys[0]! });
  const check = createVerify("RSA-SHA256");

  check.update(`${header}.${payload}`);
  assert.ok(check.verify(verifierKey, Buffer.from(signature, "base64url")));

  return {
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >,
    discovery,
  };
}

test("Google sign-in: discovery names Google's issuer, and the ID token carries hd", async () => {
  const { claims, discovery } = await signIn("dana@acme.example", "n-1");

  assert.equal(discovery.issuer, FAKE_GOOGLE_ISSUER);
  assert.equal(claims.iss, FAKE_GOOGLE_ISSUER);
  assert.equal(claims.aud, FAKE_GOOGLE_CLIENT.id);
  assert.equal(claims.email, "dana@acme.example");
  assert.equal(claims.hd, "acme.example");
  assert.equal(claims.nonce, "n-1");
  assert.equal(google.lastAuthorization()?.hd, "acme.example");

  const personal = await signIn("pat@gmail.example", "n-2");

  assert.equal(personal.claims.hd, undefined);
});

test("a wrong PKCE verifier or a reused code is refused", async () => {
  const authorize = new URL(`${google.url}/o/oauth2/v2/auth`);

  authorize.search = new URLSearchParams({
    client_id: FAKE_GOOGLE_CLIENT.id,
    code_challenge: "not-the-challenge",
    code_challenge_method: "S256",
    login_hint: "sam@acme.example",
    redirect_uri: "http://localhost/cb",
    response_type: "code",
    scope: "openid",
  }).toString();

  const redirect = await fetch(authorize, { redirect: "manual" });
  const code =
    new URL(redirect.headers.get("location") ?? "").searchParams.get("code") ??
    "";
  const exchange = () =>
    fetch(`${google.url}/token`, {
      body: new URLSearchParams({
        code,
        code_verifier: "wrong",
        grant_type: "authorization_code",
        redirect_uri: "http://localhost/cb",
      }),
      headers: {
        authorization: `Basic ${Buffer.from(`${FAKE_GOOGLE_CLIENT.id}:${FAKE_GOOGLE_CLIENT.secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

  assert.equal((await exchange()).status, 400);
  assert.equal((await exchange()).status, 400);
});

test("without a login hint, the account chooser lists every account", async () => {
  const authorize = new URL(`${google.url}/o/oauth2/v2/auth`);

  authorize.search = new URLSearchParams({
    client_id: FAKE_GOOGLE_CLIENT.id,
    redirect_uri: "http://localhost/cb",
    response_type: "code",
    scope: "openid",
  }).toString();

  const page = await (await fetch(authorize)).text();

  assert.match(page, /olga@other\.example/);
  assert.match(page, /pat@gmail\.example/);
  // A suspended account cannot sign in.
  assert.doesNotMatch(page, /daniel@acme\.example/);
});

test("the app's directory client searches people and checks nested groups", async () => {
  const credentials = createGoogleCredentials({ env: env() });

  assert.ok(credentials);

  const client = createDirectoryClient({
    config: readDirectoryConfig({ GOOGLE_WORKSPACE_DIRECTORY: "on" }),
    credentials,
    env: env(),
  });

  // Daniel is suspended, Olga is in another Workspace, Pat has none.
  assert.deepEqual(await client.searchUsers("da"), [
    { email: "dana@acme.example", name: "Dana Admin" },
  ]);
  assert.deepEqual(await client.searchUsers("sam sender"), [
    { email: "sam@acme.example", name: "Sam Sender" },
  ]);
  assert.equal(
    await client.isGroupMember(
      "signudoc-admins@acme.example",
      "sam@acme.example",
    ),
    true,
  );
  assert.equal(
    await client.isGroupMember(
      "signudoc-admins@acme.example",
      "olga@other.example",
    ),
    false,
  );
  assert.deepEqual(
    (await client.listUserGroups("sam@acme.example")).map(
      (group) => group.email,
    ),
    ["leads@acme.example"],
  );
});

test("delegation: a token for a Workspace user, and the manager in relations", async () => {
  const credentials = createGoogleCredentials({ env: env() });
  const token = await credentials!.getAccessToken({
    scopes: [GOOGLE_SCOPES.directoryUserReadonly],
    subject: "dana@acme.example",
  });

  assert.equal(google.state.accessTokens.get(token)?.user, "dana@acme.example");

  const response = await fetch(
    `${google.url}/admin/directory/v1/users/sam@acme.example?viewType=domain_public`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const user = (await response.json()) as {
    relations?: Array<{ type: string; value: string }>;
  };

  assert.deepEqual(user.relations, [
    { type: "manager", value: "dana@acme.example" },
  ]);

  // A subject who is not in the Workspace gets no token.
  await assert.rejects(
    credentials!.getAccessToken({
      scopes: [GOOGLE_SCOPES.directoryUserReadonly],
      subject: "nobody@acme.example",
    }),
  );

  // Without the scope, the directory refuses.
  const driveToken = google.issueAccessToken({
    scopes: [GOOGLE_SCOPES.drive],
    serviceAccount: key.client_email,
  });
  const refused = await fetch(
    `${google.url}/admin/directory/v1/users?customer=my_customer`,
    { headers: { authorization: `Bearer ${driveToken}` } },
  );

  assert.equal(refused.status, 403);
});

test("an assertion signed with another key is refused", async () => {
  const impostor = createFakeServiceAccountKey(key.client_email);
  const credentials = createGoogleCredentials({
    env: {
      ...google.env,
      GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(impostor),
    },
  });

  await assert.rejects(
    credentials!.getAccessToken({ scopes: [GOOGLE_SCOPES.drive] }),
  );
});

function driveToken() {
  return google.issueAccessToken({
    scopes: [GOOGLE_SCOPES.drive],
    serviceAccount: key.client_email,
  });
}

async function drive(
  path: string,
  init: {
    body?: string | Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Promise<Response> {
  return fetch(`${google.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${driveToken()}`, ...init.headers },
  });
}

function multipart(metadata: unknown, content: Buffer, type: string) {
  const boundary = "fake-boundary-42";

  return {
    body: new Uint8Array(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${type}\r\n\r\n`,
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    ),
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
  };
}

test("Drive: a Word upload is converted, found by appProperties, and exported to PDF", async () => {
  const docx = Buffer.from("PK\u0003\u0004 pretend docx");
  const upload = multipart(
    {
      appProperties: { signudocEnvelope: "env-1" },
      mimeType: GOOGLE_APPS.document,
      name: "Agreement",
      parents: ["0AFakeLegal"],
    },
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  // In a shared drive, only with supportsAllDrives.
  assert.equal(
    (
      await drive("/upload/drive/v3/files?uploadType=multipart", {
        ...upload,
        method: "POST",
      })
    ).status,
    404,
  );

  const created = (await (
    await drive(
      "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,mimeType,driveId,appProperties",
      { ...upload, method: "POST" },
    )
  ).json()) as Record<string, unknown>;

  assert.equal(created.mimeType, GOOGLE_APPS.document);
  assert.equal(created.driveId, "0AFakeLegal");

  const query = new URLSearchParams({
    corpora: "drive",
    driveId: "0AFakeLegal",
    fields: "files(id,name)",
    includeItemsFromAllDrives: "true",
    q: "appProperties has { key='signudocEnvelope' and value='env-1' } and trashed = false",
    supportsAllDrives: "true",
  });
  const listed = (await (
    await drive(`/drive/v3/files?${query.toString()}`)
  ).json()) as { files: Array<{ id: string; name: string }> };

  assert.deepEqual(listed.files, [{ id: created.id, name: "Agreement" }]);

  // A Google Doc is exported, not downloaded.
  assert.equal(
    (
      await drive(
        `/drive/v3/files/${String(created.id)}?alt=media&supportsAllDrives=true`,
      )
    ).status,
    403,
  );

  const exported = await drive(
    `/drive/v3/files/${String(created.id)}/export?mimeType=application%2Fpdf&supportsAllDrives=true`,
  );

  assert.equal(exported.status, 200);
  assert.equal(
    Buffer.from(await exported.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
});

test("Drive: a resumable upload to My Drive, then download and default fields", async () => {
  const start = await drive("/upload/drive/v3/files?uploadType=resumable", {
    body: JSON.stringify({ name: "signed.pdf" }),
    headers: {
      "content-type": "application/json",
      "x-upload-content-type": "application/pdf",
    },
    method: "POST",
  });
  const location = start.headers.get("location") ?? "";

  assert.equal(start.status, 200);

  const finished = (await (
    await drive(new URL(location).pathname + new URL(location).search, {
      body: "%PDF-1.4 tiny",
      method: "PUT",
    })
  ).json()) as Record<string, unknown>;

  // Without ?fields, only these come back, as from Drive.
  assert.deepEqual(Object.keys(finished).sort(), [
    "id",
    "kind",
    "mimeType",
    "name",
  ]);
  assert.equal(finished.mimeType, "application/pdf");

  const media = await drive(`/drive/v3/files/${String(finished.id)}?alt=media`);

  assert.equal(await media.text(), "%PDF-1.4 tiny");

  const inRoot = (await (
    await drive(
      `/drive/v3/files?q=${encodeURIComponent(`'root' in parents and name = 'signed.pdf'`)}&fields=files(id,parents)`,
    )
  ).json()) as { files: Array<{ id: string; parents: string[] }> };

  assert.deepEqual(inRoot.files, [
    { id: finished.id, parents: [ROOT_FOLDER_ID] },
  ]);

  const drives = (await (await drive("/drive/v3/drives")).json()) as {
    drives: Array<{ id: string; name: string }>;
  };

  assert.deepEqual(
    drives.drives.map((item) => item.name),
    ["Legal"],
  );
});

test("Drive: an unknown query term is an error, not a silent match", async () => {
  const response = await drive(
    `/drive/v3/files?q=${encodeURIComponent("starred = true")}`,
  );

  assert.equal(response.status, 400);
});
