import assert from "node:assert/strict";
import { test } from "node:test";

import * as routes from "./drive-routes.ts";
import { DriveAuthorizationError } from "./integrations/google/drive-oauth.ts";

test("Drive open sends only a missing connection to connect", () => {
  assert.deepEqual(
    routes.driveOpenFailure(
      new DriveAuthorizationError("not_connected", "Connect Google Drive."),
    ),
    { connect: true },
  );
});

test("Drive open does not send a Google outage to connect", () => {
  assert.deepEqual(
    routes.driveOpenFailure(
      new DriveAuthorizationError("failed", "Google could not be reached."),
    ),
    { problem: "import_failed" },
  );
});

test("Drive open says when Drive is not set up", () => {
  assert.deepEqual(
    routes.driveOpenFailure(
      new DriveAuthorizationError("not_configured", "Not set up."),
    ),
    { problem: "not_configured" },
  );
});

test("an import answers a Google outage as unreachable, not as a reconnect", () => {
  assert.equal(
    routes.describeImportFailure(
      new DriveAuthorizationError("failed", "Google could not be reached."),
    ),
    null,
  );
});

test("an import asks to reconnect when the connection is gone", () => {
  assert.deepEqual(
    routes.describeImportFailure(
      new DriveAuthorizationError("not_connected", "Connect Google Drive."),
    ),
    { message: "Connect Google Drive, then try again.", status: 409 },
  );
});
