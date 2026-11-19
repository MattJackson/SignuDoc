import assert from "node:assert/strict";
import type { lookup } from "node:dns";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { Readable } from "node:stream";

import {
  fetchFromOwnDomain,
  isAllowedLogoHost,
  isPublicAddress,
  LogoFetchError,
  MAX_LOGO_HTML_BYTES,
  MAX_LOGO_IMAGE_BYTES,
  refuseLogoUrl,
} from "./logo-fetch.ts";

test("private, loopback, link-local and other non-public addresses are refused", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.10",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1::1",
    "fec0::1",
    "2002:a00:1::",
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "not an address",
    "",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("public addresses are allowed", () => {
  for (const address of [
    "8.8.8.8",
    "142.250.80.46",
    "172.32.0.1",
    "100.128.0.1",
    "2607:f8b0:4004:c07::64",
    "2a00:1450:4001:82a::200e",
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("only the install's own domains and their subdomains are fetched", () => {
  const domains = ["example.com", "Acme.co.uk"];

  assert.equal(isAllowedLogoHost("example.com", domains), true);
  assert.equal(isAllowedLogoHost("www.example.com", domains), true);
  assert.equal(isAllowedLogoHost("WWW.EXAMPLE.COM.", domains), true);
  assert.equal(isAllowedLogoHost("cdn.acme.co.uk", domains), true);
  assert.equal(isAllowedLogoHost("badexample.com", domains), false);
  assert.equal(isAllowedLogoHost("example.com.evil.net", domains), false);
  assert.equal(isAllowedLogoHost("127.0.0.1", ["127.0.0.1"]), false);
  assert.equal(isAllowedLogoHost("[::1]", ["::1"]), false);
  assert.equal(isAllowedLogoHost("example.com", []), false);
});

test("an address is refused unless it is https on the standard port at an own domain", () => {
  const domains = ["example.com"];
  const refused = (value: string) => refuseLogoUrl(new URL(value), domains);

  assert.equal(refused("https://www.example.com/logo.png"), null);
  assert.equal(refused("https://example.com:443/"), null);
  assert.match(refused("http://example.com/") ?? "", /https/);
  assert.match(refused("https://example.com:8443/") ?? "", /port/);
  assert.match(refused("https://user:pw@example.com/") ?? "", /user name/);
  assert.match(refused("https://other.org/") ?? "", /not one of/);
  assert.match(refused("https://169.254.169.254/") ?? "", /not one of/);
  assert.match(refused("file:///etc/passwd") ?? "", /https/);
});

function stubLookup(addresses: Array<{ address: string; family: number }>) {
  return ((
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, list: typeof addresses) => void,
  ) => {
    callback(null, addresses);
  }) as unknown as typeof lookup;
}

test("a domain that resolves to a private address is not connected to", async () => {
  for (const addresses of [
    [{ address: "10.0.0.5", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    [{ address: "::1", family: 6 }],
    [],
  ]) {
    await assert.rejects(
      fetchFromOwnDomain("https://www.example.com/", {
        domains: ["example.com"],
        kind: "html",
        lookup: stubLookup(addresses),
      }),
      (error: unknown) =>
        error instanceof LogoFetchError && /public address/.test(error.message),
    );
  }
});

test("addresses outside the rules are refused before anything is looked up", async () => {
  let looked = false;
  const lookupSpy = ((...args: unknown[]) => {
    looked = true;
    (args[2] as (error: Error) => void)(new Error("should not be called"));
  }) as unknown as typeof lookup;

  for (const address of [
    "http://example.com/",
    "https://elsewhere.org/",
    "https://10.0.0.1/",
    "not a url",
  ]) {
    await assert.rejects(
      fetchFromOwnDomain(address, {
        domains: ["example.com"],
        kind: "image",
        lookup: lookupSpy,
      }),
      LogoFetchError,
    );
  }

  assert.equal(looked, false);
});

// The https connection is replaced by a script, so what is done with the
// answers (redirects, types, sizes, the time limit) is tested on its own.
type Answer = {
  body?: Buffer[];
  headers?: Record<string, string>;
  status?: number;
};

const realRequest = https.request;

function scripted(answer: (url: string, call: number) => Answer | "silent") {
  const seen: string[] = [];

  https.request = ((
    options: { hostname: string; path: string; signal?: AbortSignal },
    callback: (response: Readable) => void,
  ) => {
    const emitter = new EventEmitter();
    const request = Object.assign(emitter, {
      destroy() {},
      end() {
        const url = `https://${options.hostname}${options.path}`;

        seen.push(url);

        const scriptedAnswer = answer(url, seen.length);

        if (scriptedAnswer === "silent") {
          options.signal?.addEventListener("abort", () => {
            emitter.emit(
              "error",
              Object.assign(new Error("x"), { name: "AbortError" }),
            );
          });
          return;
        }

        queueMicrotask(() => {
          const response = Object.assign(new Readable({ read() {} }), {
            headers: scriptedAnswer.headers ?? {},
            statusCode: scriptedAnswer.status ?? 200,
          });

          callback(response);

          for (const chunk of scriptedAnswer.body ?? []) {
            response.push(chunk);
          }

          response.push(null);
        });
      },
    });

    return request;
  }) as unknown as typeof https.request;
  syncBuiltinESMExports();

  return {
    restore() {
      https.request = realRequest;
      syncBuiltinESMExports();
    },
    seen,
  };
}

const html = { "content-type": "text/html; charset=utf-8" };
const open = (kind: "html" | "image", address = "https://www.example.com/a") =>
  fetchFromOwnDomain(address, {
    domains: ["example.com"],
    kind,
    lookup: stubLookup([{ address: "93.184.216.34", family: 4 }]),
    timeoutMs: 100,
  });
const refusal = (pattern: RegExp) => (error: unknown) =>
  error instanceof LogoFetchError && pattern.test(error.message);

test("a redirect is followed, and each hop is checked against the rules", async () => {
  const script = scripted((url) =>
    url.endsWith("/a")
      ? { headers: { location: "/b" }, status: 302 }
      : { body: [Buffer.from("<html>")], headers: html },
  );

  try {
    const result = await open("html");

    assert.equal(result.url, "https://www.example.com/b");
    assert.equal(Buffer.from(result.bytes).toString(), "<html>");
  } finally {
    script.restore();
  }

  for (const location of [
    "https://evil.example.org/x",
    "http://www.example.com/x",
    "https://10.0.0.1/x",
  ]) {
    const hop = scripted(() => ({ headers: { location }, status: 301 }));

    try {
      await assert.rejects(open("html"), LogoFetchError);
      assert.equal(hop.seen.length, 1, location);
    } finally {
      hop.restore();
    }
  }
});

test("a redirect loop stops after three redirects, and a redirect to nowhere fails", async () => {
  const loop = scripted(() => ({ headers: { location: "/a" }, status: 302 }));

  try {
    await assert.rejects(open("html"), refusal(/too many times/));
    assert.equal(loop.seen.length, 4);
  } finally {
    loop.restore();
  }

  const nowhere = scripted(() => ({ status: 302 }));

  try {
    await assert.rejects(open("html"), refusal(/redirected nowhere/));
  } finally {
    nowhere.restore();
  }
});

test("only the types asked for are taken, and any other status is an error", async () => {
  const wrong = scripted(() => ({
    body: [Buffer.from("x")],
    headers: { "content-type": "text/plain" },
  }));

  try {
    await assert.rejects(open("html"), refusal(/text\/plain/));
    await assert.rejects(open("image"), refusal(/text\/plain/));
  } finally {
    wrong.restore();
  }

  const page = scripted(() => ({
    body: [Buffer.from("x")],
    headers: html,
  }));

  try {
    await assert.rejects(open("image"), refusal(/text\/html/));
  } finally {
    page.restore();
  }

  const image = scripted(() => ({
    body: [Buffer.from("x")],
    headers: { "content-type": "Image/PNG; charset=binary" },
  }));

  try {
    assert.equal((await open("image")).contentType, "image/png");
  } finally {
    image.restore();
  }

  const missing = scripted(() => ({ headers: html, status: 404 }));

  try {
    await assert.rejects(open("html"), refusal(/answered 404/));
  } finally {
    missing.restore();
  }
});

test("what is read is capped, by the stated length and by what arrives", async () => {
  const cases: Array<["html" | "image", number]> = [
    ["html", MAX_LOGO_HTML_BYTES],
    ["image", MAX_LOGO_IMAGE_BYTES],
  ];

  for (const [kind, cap] of cases) {
    const type = kind === "html" ? "text/html" : "image/png";
    const stated = scripted(() => ({
      body: [Buffer.from("x")],
      headers: { "content-length": String(cap + 1), "content-type": type },
    }));

    try {
      await assert.rejects(open(kind), refusal(/too large/));
    } finally {
      stated.restore();
    }

    const streamed = scripted(() => ({
      body: [Buffer.alloc(cap), Buffer.alloc(1)],
      headers: { "content-type": type },
    }));

    try {
      await assert.rejects(open(kind), refusal(/too large/));
    } finally {
      streamed.restore();
    }

    const exact = scripted(() => ({
      body: [Buffer.alloc(cap)],
      headers: { "content-type": type },
    }));

    try {
      assert.equal((await open(kind)).bytes.length, cap);
    } finally {
      exact.restore();
    }
  }
});

test("a server that never answers is given up on", async () => {
  const silent = scripted(() => "silent");

  try {
    await assert.rejects(open("html"), refusal(/took too long/));
  } finally {
    silent.restore();
  }
});
