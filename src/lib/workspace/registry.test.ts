import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configuredWorkspaceProviders,
  findWorkspaceProvider,
  resolveCapabilityProvider,
  WORKSPACE_PROVIDERS,
} from "./registry.ts";
import type { WorkspaceProviderPackage } from "./types.ts";

// Providers chosen per capability, with stand-in packages: a suite that
// offers everything, a directory-only one and a files-only one.

const setup = () => ({
  check: async () => [],
  identity: async () => ({ account: null, configured: false, description: "" }),
});
const suite: WorkspaceProviderPackage = {
  addIn: () => null,
  directory: () => null,
  files: () => null,
  id: "suite",
  label: "Suite",
  setup,
};
const directoryOnly: WorkspaceProviderPackage = {
  directory: () => null,
  id: "people",
  label: "People",
  setup,
};
const filesOnly: WorkspaceProviderPackage = {
  files: () => null,
  id: "boxes",
  label: "Boxes",
  setup,
};
const providers = [suite, directoryOnly, filesOnly];

function chosen(
  capability: "addIn" | "directory" | "files",
  env: Record<string, string>,
  stored: Record<string, string> | null = null,
) {
  const choice = resolveCapabilityProvider(capability, stored, env, providers);

  return choice.provider ? `${choice.provider.id}:${choice.source}` : null;
}

test("nothing is chosen unless configured", () => {
  for (const capability of ["addIn", "directory", "files"] as const) {
    assert.equal(chosen(capability, {}), null);
  }

  assert.deepEqual(configuredWorkspaceProviders(null, {}, providers), []);
});

test("one provider for everything is one setting", () => {
  const env = { WORKSPACE_PROVIDER: "Suite" };

  assert.equal(chosen("directory", env), "suite:env");
  assert.equal(chosen("files", env), "suite:env");
  assert.equal(chosen("addIn", env), "suite:env");
  assert.equal(
    chosen("files", {}, { "workspace.provider": "suite" }),
    "suite:settings",
  );
});

test("providers can be mixed per capability", () => {
  const env = {
    WORKSPACE_DIRECTORY_PROVIDER: "people",
    WORKSPACE_FILES_PROVIDER: "boxes",
  };

  assert.equal(chosen("directory", env), "people:env");
  assert.equal(chosen("files", env), "boxes:env");
  assert.equal(chosen("addIn", env), null);
  assert.deepEqual(
    configuredWorkspaceProviders(null, env, providers).map((item) => item.id),
    ["people", "boxes"],
  );

  // A capability's own choice wins over the default; the environment wins
  // over Settings.
  assert.equal(
    chosen(
      "directory",
      { WORKSPACE_PROVIDER: "suite" },
      { "directory.provider": "people" },
    ),
    "people:settings",
  );
  assert.equal(
    chosen(
      "directory",
      { WORKSPACE_DIRECTORY_PROVIDER: "suite" },
      { "directory.provider": "people" },
    ),
    "suite:env",
  );
});

test("a provider without the capability, or an unknown one, serves nothing", () => {
  assert.equal(chosen("files", { WORKSPACE_PROVIDER: "people" }), null);
  assert.equal(
    chosen("directory", { WORKSPACE_FILES_PROVIDER: "people" }),
    null,
  );
  assert.equal(chosen("files", { WORKSPACE_FILES_PROVIDER: "people" }), null);
  assert.equal(chosen("files", { WORKSPACE_PROVIDER: "nope" }), null);
});

test("Google Workspace is installed", () => {
  const google = findWorkspaceProvider("google");

  assert.ok(google);
  assert.equal(google.label, "Google Workspace");
  assert.ok(WORKSPACE_PROVIDERS.includes(google));
});

test("the Google package with nothing configured says what to set", async () => {
  const google = findWorkspaceProvider("google");
  const setupForGoogle = google!.setup({
    env: { HOME: "/nowhere" },
    settings: {},
  });
  const identity = await setupForGoogle.identity();

  assert.equal(identity.configured, false);
  assert.match(identity.description, /GOOGLE_SERVICE_ACCOUNT_KEY/);
  assert.equal((await setupForGoogle.check("identity"))[0]?.ok, false);
  // With no identity the directory cannot be read either.
  assert.equal((await setupForGoogle.check("directory"))[0]?.ok, false);
  assert.deepEqual(
    (await setupForGoogle.check("files")).map((check) => [check.id, check.ok]),
    [
      ["files.picker", false],
      ["files.destination", false],
    ],
  );
  // The add-on: its values and the site's address; Google's keys are not
  // read before the values are set.
  assert.deepEqual(
    (await setupForGoogle.check("addIn")).map((check) => [check.id, check.ok]),
    [
      ["addIn.values", false],
      ["addIn.address", false],
    ],
  );
});
