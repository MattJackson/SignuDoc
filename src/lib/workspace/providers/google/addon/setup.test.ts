import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { checkGoogleAddon, describeAddonDeployment } from "./setup.ts";

// What Settings shows to deploy the add-on, and its checks.

const SITE = {
  brandColor: "#123456",
  name: "Example Inc",
  url: "https://sign.example.test",
};
const VALUES = {
  GOOGLE_ADDON_CLIENT_ID: "117000000000000000001",
  GOOGLE_ADDON_SERVICE_ACCOUNT:
    "service-42@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
};

test("the deployment file carries this site's URLs and name", () => {
  const deployment = describeAddonDeployment({ env: {}, site: SITE });
  const file = JSON.parse(deployment.file?.content ?? "{}") as {
    addOns: {
      common: { layoutProperties: { primaryColor: string }; name: string };
      drive: { onItemsSelectedTrigger: { runFunction: string } };
    };
  };

  assert.equal(deployment.file?.name, "signudoc-addon.json");
  assert.equal(file.addOns.common.name, "Example Inc SignuDoc");
  assert.equal(file.addOns.common.layoutProperties.primaryColor, "#123456");
  assert.equal(
    file.addOns.drive.onItemsSelectedTrigger.runFunction,
    "https://sign.example.test/api/workspace/add-in/drive-items",
  );
  assert.equal(deployment.problem, null);
  assert.equal(deployment.ready, false);
  assert.deepEqual(
    deployment.values.map((value) => [value.setting, value.source]),
    [
      ["google.addonServiceAccount", "none"],
      ["google.addonClientId", "none"],
    ],
  );
  assert.ok(
    deployment.steps.some((step) =>
      step.command?.startsWith("gcloud workspace-add-ons get-authorization"),
    ),
  );
});

test("a site with no public HTTPS address is told why Google cannot call it", () => {
  const local = describeAddonDeployment({
    env: {},
    site: { ...SITE, url: "http://localhost:3000" },
  });

  assert.match(local.problem ?? "", /public HTTPS/);

  const unknown = describeAddonDeployment({
    env: {},
    site: { ...SITE, url: null },
  });

  assert.equal(unknown.file, null);
  assert.match(unknown.problem ?? "", /APP_URL/);
});

test("the checks say what is missing, and read Google's keys once set", async () => {
  let fetched = 0;
  const jwk = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ format: "jwk" });
  const fetchImpl = (async () => {
    fetched += 1;
    return Response.json({ keys: [{ ...jwk, kid: "key-1" }] });
  }) as typeof fetch;

  const unset = await checkGoogleAddon({
    env: { APP_URL: SITE.url },
    fetchImpl,
  });

  assert.deepEqual(
    unset.map((check) => [check.id, check.ok]),
    [
      ["addIn.values", false],
      ["addIn.address", true],
    ],
  );
  assert.match(unset[0]!.message, /GOOGLE_ADDON_SERVICE_ACCOUNT/);
  assert.equal(fetched, 0);

  const set = await checkGoogleAddon({
    env: { APP_URL: SITE.url, ...VALUES },
    fetchImpl,
  });

  assert.deepEqual(
    set.map((check) => [check.id, check.ok]),
    [
      ["addIn.values", true],
      ["addIn.address", true],
      ["addIn.keys", true],
    ],
  );

  const offline = await checkGoogleAddon({
    env: { APP_URL: SITE.url, ...VALUES },
    fetchImpl: (async () =>
      new Response("no", { status: 503 })) as typeof fetch,
  });

  assert.equal(offline[2]?.ok, false);
});
