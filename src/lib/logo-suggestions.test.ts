import assert from "node:assert/strict";
import { test } from "node:test";

import { LogoFetchError, type fetchFromOwnDomain } from "./logo-fetch.ts";
import {
  fetchChosenLogo,
  findLogoSuggestions,
  logoDomains,
  prepareLogo,
} from "./logo-suggestions.ts";
import { resolveSettings } from "./settings.ts";

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);

  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(16, size);
  view.setUint32(20, size);

  return bytes;
}

test("PNG, JPEG and WebP are taken; SVG, bitmap icons and large images are not", () => {
  const ok = prepareLogo("image/png", png(180));

  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.contentType, "image/png");

  const svg = prepareLogo("image/svg+xml", new TextEncoder().encode("<svg/>"));

  assert.equal(svg.ok, false);
  assert.match(!svg.ok ? svg.reason : "", /SVG/);

  const fake = prepareLogo("image/png", new TextEncoder().encode("<html>"));

  assert.equal(fake.ok, false);

  const large = new Uint8Array(600 * 1024);

  large.set(png(2000), 0);
  assert.match(
    (() => {
      const result = prepareLogo("image/png", large);
      return result.ok ? "" : result.reason;
    })(),
    /512 KB/,
  );

  const bitmapIcon = new Uint8Array(22);

  bitmapIcon.set([0, 0, 1, 0, 1, 0], 0);
  assert.equal(prepareLogo("image/x-icon", bitmapIcon).ok, false);
});

test("the domains asked are the administrator's, the Workspace's and sign-up's, never a mailbox provider's", () => {
  const settings = resolveSettings(null, {});

  assert.deepEqual(
    logoDomains({
      adminEmail: "Admin@Example.com",
      env: { GOOGLE_WORKSPACE_DOMAINS: "example.com, example.org" },
      settings: {
        ...settings,
        allowedEmailDomains: ["example.net"],
        signupMode: "domains",
      },
      stored: {},
    }),
    ["example.com", "example.org", "example.net"],
  );
  assert.deepEqual(
    logoDomains({
      adminEmail: "someone@gmail.com",
      env: {},
      settings,
      stored: {},
    }),
    [],
  );
});

test("suggestions come from the home page, usable ones first, with previews", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, options) => {
    asked.push(url);

    if (url === "https://example.com/") {
      return {
        bytes: new TextEncoder().encode(
          `<link rel="icon" href="/logo.svg"><link rel="apple-touch-icon" href="/touch.png">`,
        ),
        contentType: "text/html",
        url: "https://www.example.com/",
      };
    }

    assert.equal(options.kind, "image");
    assert.deepEqual(options.domains, ["example.com"]);

    if (url === "https://www.example.com/touch.png") {
      return { bytes: png(180), contentType: "image/png", url };
    }

    if (url === "https://www.example.com/logo.svg") {
      return {
        bytes: new TextEncoder().encode("<svg/>"),
        contentType: "image/svg+xml",
        url,
      };
    }

    throw new LogoFetchError("example.com answered 404.");
  }) as typeof fetchFromOwnDomain;
  const result = await findLogoSuggestions(
    "example.com",
    ["example.com"],
    fetchImpl,
  );

  assert.equal(result.pageProblem, null);
  assert.deepEqual(
    result.suggestions.map((item) => [
      item.url,
      item.dimensions,
      item.problem === null,
    ]),
    [
      ["https://www.example.com/touch.png", "180 x 180", true],
      ["https://www.example.com/logo.svg", null, false],
    ],
  );
  assert.match(
    result.suggestions[0]!.preview ?? "",
    /^data:image\/png;base64,/,
  );
  // The missing /favicon.ico is left out rather than shown broken.
  assert.ok(asked.includes("https://www.example.com/favicon.ico"));
});

test("an unreadable website still offers /favicon.ico, and says why", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/favicon.ico")) {
      return { bytes: png(48), contentType: "image/png", url };
    }

    throw new LogoFetchError("example.com took too long to answer.");
  }) as typeof fetchFromOwnDomain;
  const result = await findLogoSuggestions(
    "example.com",
    ["example.com"],
    fetchImpl,
  );

  assert.equal(result.pageProblem, "example.com took too long to answer.");
  assert.deepEqual(
    result.suggestions.map((item) => item.url),
    ["https://example.com/favicon.ico"],
  );
});

test("the chosen logo is fetched again and checked", async () => {
  const fetchImpl = (async (url: string) => ({
    bytes: png(64),
    contentType: "image/png",
    url,
  })) as typeof fetchFromOwnDomain;

  assert.equal(
    (
      await fetchChosenLogo(
        "https://example.com/a.png",
        ["example.com"],
        fetchImpl,
      )
    ).ok,
    true,
  );

  const failing = (async () => {
    throw new LogoFetchError("other.org is not one of this site's domains.");
  }) as typeof fetchFromOwnDomain;
  const refused = await fetchChosenLogo(
    "https://other.org/a.png",
    ["example.com"],
    failing,
  );

  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /not one of/);
});
