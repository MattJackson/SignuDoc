import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAddonAction,
  normalizeOAuthClientId,
  normalizeServiceAccountEmail,
  readAddonConfig,
} from "./config.ts";
import { AddonEventError, parseAddonEvent, readBearerToken } from "./event.ts";

// The event objects Google posts, as its documentation shows them, read
// into what the handlers use.

test("a Gmail event gives the open message and the tokens", () => {
  const event = parseAddonEvent({
    authorizationEventObject: {
      systemIdToken: "system.token.value",
      userIdToken: "user.token.value",
      userOAuthToken: "ya29.user",
    },
    commonEventObject: {
      hostApp: "GMAIL",
      parameters: { action: "send-attachment", partId: "1" },
      platform: "WEB",
    },
    gmail: {
      accessToken: "message-token",
      messageId: "msg-1",
      threadId: "thread-1",
    },
    somethingNew: { from: "a later version" },
  });

  assert.equal(event.hostApp, "gmail");
  assert.deepEqual(event.gmail, {
    accessToken: "message-token",
    messageId: "msg-1",
    threadId: "thread-1",
  });
  assert.equal(event.drive, null);
  assert.deepEqual(event.parameters, {
    action: "send-attachment",
    partId: "1",
  });
  assert.equal(event.systemIdToken, "system.token.value");
  assert.equal(event.userIdToken, "user.token.value");
  assert.equal(event.userOAuthToken, "ya29.user");
});

test("a Drive event gives the selection, or the item under the cursor", () => {
  const selected = parseAddonEvent({
    commonEventObject: { hostApp: "DRIVE" },
    drive: {
      activeCursorItem: {
        id: "cursor",
        mimeType: "application/pdf",
        title: "C",
      },
      selectedItems: [
        {
          addonHasFileScopePermission: true,
          id: "file-1",
          mimeType: "application/vnd.google-apps.document",
          title: "Contract",
        },
        { id: "file-2", mimeType: "application/pdf" },
      ],
    },
  });

  assert.equal(selected.hostApp, "drive");
  assert.deepEqual(selected.drive?.selectedItems, [
    {
      hasFileScope: true,
      id: "file-1",
      mimeType: "application/vnd.google-apps.document",
      title: "Contract",
    },
    {
      hasFileScope: false,
      id: "file-2",
      mimeType: "application/pdf",
      title: "Untitled",
    },
  ]);

  const cursorOnly = parseAddonEvent({
    commonEventObject: { hostApp: "DRIVE" },
    drive: { activeCursorItem: { id: "cursor", title: "C" } },
  });

  assert.deepEqual(
    cursorOnly.drive?.selectedItems.map((item) => item.id),
    ["cursor"],
  );
});

test("missing parts are empty, and a broken event is refused", () => {
  const empty = parseAddonEvent({});

  assert.equal(empty.hostApp, "other");
  assert.equal(empty.gmail, null);
  assert.equal(empty.systemIdToken, "");
  assert.deepEqual(empty.parameters, {});

  // A message with no access token cannot be read, so there is none.
  assert.equal(parseAddonEvent({ gmail: { messageId: "m" } }).gmail, null);

  assert.throws(() => parseAddonEvent(null), AddonEventError);
  assert.throws(
    () => parseAddonEvent({ commonEventObject: { parameters: { a: 1 } } }),
    AddonEventError,
  );
  assert.throws(
    () =>
      parseAddonEvent({
        authorizationEventObject: { userIdToken: "x".repeat(10_000) },
      }),
    AddonEventError,
  );
});

test("the bearer token is read from the Authorization header", () => {
  assert.equal(readBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(readBearerToken("bearer  abc"), "abc");
  assert.equal(readBearerToken("Basic abc"), "");
  assert.equal(readBearerToken(null), "");
});

test("the add-on's settings come from the environment first", () => {
  const stored = {
    "google.addonClientId": "111111111111111111111",
    "google.addonServiceAccount":
      "service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  };

  const fromSettings = readAddonConfig({}, stored);

  assert.equal(fromSettings.ready, true);
  assert.equal(fromSettings.serviceAccountSource, "settings");

  const fromEnv = readAddonConfig(
    {
      GOOGLE_ADDON_AUDIENCE: "https://proxy.example/hook, not-a-url",
      GOOGLE_ADDON_SERVICE_ACCOUNT:
        "Service-2@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    },
    stored,
  );

  assert.equal(
    fromEnv.serviceAccountEmail,
    "service-2@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  );
  assert.equal(fromEnv.serviceAccountSource, "env");
  assert.equal(fromEnv.oauthClientIdSource, "settings");
  assert.deepEqual(fromEnv.extraAudiences, ["https://proxy.example/hook"]);

  assert.equal(readAddonConfig({}, null).ready, false);
  assert.equal(
    readAddonConfig({}, { ...stored, "google.addonClientId": "not valid!" })
      .ready,
    false,
  );
  assert.equal(normalizeServiceAccountEmail("someone@gmail.com"), null);
  assert.equal(normalizeOAuthClientId("has spaces in it"), null);
  assert.equal(isAddonAction("gmail-message"), true);
  assert.equal(isAddonAction("../admin"), false);
});

test("a long Drive selection or title is cut, not refused", () => {
  const event = parseAddonEvent({
    drive: {
      selectedItems: Array.from({ length: 101 }, (_, index) => ({
        id: `file-${String(index)}`,
        title: index === 0 ? "t".repeat(2000) : "Doc",
      })),
    },
  });

  assert.equal(event.drive?.selectedItems.length, 100);
  assert.equal(event.drive?.selectedItems[0]?.id, "file-0");
  assert.equal(event.drive?.selectedItems[0]?.title.length, 1024);
});
