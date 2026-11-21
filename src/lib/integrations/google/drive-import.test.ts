import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDriveId } from "../../google-drive.ts";
import { parseDriveOpenState } from "./drive-import.ts";

// Reading what Drive's "Open with" sends, and a Shared Drive's ID from what
// an administrator pastes.

const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

test("Open with names the first file, from ids or exportIds", () => {
  assert.deepEqual(
    parseDriveOpenState(
      JSON.stringify({
        action: "open",
        ids: [FILE, "2nd-file-000000"],
        userId: "1234567890",
      }),
    ),
    { action: "open", fileId: FILE, googleUserId: "1234567890" },
  );
  assert.equal(
    parseDriveOpenState(JSON.stringify({ action: "open", exportIds: [FILE] }))
      ?.fileId,
    FILE,
  );
});

test("a state that is not Drive's is refused", () => {
  assert.equal(parseDriveOpenState(null), null);
  assert.equal(parseDriveOpenState("not json"), null);
  assert.equal(
    parseDriveOpenState(JSON.stringify({ action: "delete", ids: [FILE] })),
    null,
  );
  assert.equal(
    parseDriveOpenState(JSON.stringify({ action: "open", ids: ["../etc"] })),
    null,
  );
  assert.equal(
    parseDriveOpenState(JSON.stringify({ action: "create", folderId: "x" }))
      ?.action,
    "create",
  );
});

test("a Shared Drive's ID is read from itself or from its address", () => {
  assert.equal(extractDriveId("0AAbCdEfGhIjKUk9PVA"), "0AAbCdEfGhIjKUk9PVA");
  assert.equal(
    extractDriveId(
      "https://drive.google.com/drive/u/0/folders/0AAbCdEfGhIjKUk9PVA",
    ),
    "0AAbCdEfGhIjKUk9PVA",
  );
  assert.equal(extractDriveId("not an id!"), null);
  assert.equal(extractDriveId("  "), null);
});
