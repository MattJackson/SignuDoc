import assert from "node:assert/strict";
import type { lookup } from "node:dns";
import { test } from "node:test";

import {
  fetchFromOwnDomain,
  isAllowedLogoHost,
  isPublicAddress,
  LogoFetchError,
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
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
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
