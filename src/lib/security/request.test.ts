import assert from "node:assert/strict";
import { test } from "node:test";

import { auditEventRecordSchema } from "../schemas/envelope.ts";
import {
  CLIENT_IP_REQUEST_HEADER,
  getClientIpAddress,
  getClientIpHeaderNames,
  getRequestUserAgent,
  resolveClientIpSource,
  withClientIpHeader,
} from "./request.ts";

const onVercel = { VERCEL: "1" };
const onCloudRun = { K_SERVICE: "signudoc" };
const elsewhere = {};

test("on Vercel, the address Vercel wrote wins over one the visitor could have sent", () => {
  const headers = new Headers({
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "198.51.100.7",
    "x-real-ip": "203.0.113.5",
    "x-vercel-forwarded-for": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, onVercel), "203.0.113.5");
  assert.equal(
    getClientIpAddress(
      new Headers({
        "x-forwarded-for": "198.51.100.7",
        "x-real-ip": "203.0.113.5",
      }),
      onVercel,
    ),
    "203.0.113.5",
  );
  assert.deepEqual(getClientIpHeaderNames(onVercel), [
    "x-vercel-forwarded-for",
    "x-real-ip",
    "x-forwarded-for",
  ]);
});

test("off Vercel, Vercel's header means nothing and the last X-Forwarded-For entry is used", () => {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7, 203.0.113.5",
    "x-vercel-forwarded-for": "198.51.100.9",
  });

  assert.equal(getClientIpAddress(headers, elsewhere), "203.0.113.5");
  assert.equal(
    getClientIpHeaderNames(elsewhere).includes("x-vercel-forwarded-for"),
    false,
  );
  assert.deepEqual(getClientIpHeaderNames(elsewhere), [
    CLIENT_IP_REQUEST_HEADER,
    "x-forwarded-for",
  ]);
});

test("on Cloud Run, an address the visitor put in X-Forwarded-For is not trusted", () => {
  // Google's front end appends the address the request came from, so a
  // visitor who sends their own header only adds entries to its left.
  const headers = new Headers({
    "x-forwarded-for": "10.0.0.1, 192.0.2.44",
    "x-real-ip": "10.0.0.2",
  });

  assert.equal(getClientIpAddress(headers, onCloudRun), "192.0.2.44");
});

test("cf-connecting-ip and x-real-ip are not trusted unless CLIENT_IP_HEADER names one", () => {
  const headers = new Headers({
    "cf-connecting-ip": "198.51.100.9",
    "x-real-ip": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, elsewhere), null);
  assert.equal(
    getClientIpAddress(headers, { CLIENT_IP_HEADER: "CF-Connecting-IP" }),
    "198.51.100.9",
  );
  assert.equal(
    getClientIpAddress(new Headers({ "x-forwarded-for": "198.51.100.7" }), {
      CLIENT_IP_HEADER: "cf-connecting-ip",
    }),
    null,
  );
  assert.deepEqual(getClientIpHeaderNames({ CLIENT_IP_HEADER: "x-real-ip" }), [
    CLIENT_IP_REQUEST_HEADER,
    "x-real-ip",
  ]);
});

test("TRUSTED_PROXY_HOPS counts the proxies that append to X-Forwarded-For", () => {
  const behindLoadBalancer = { K_SERVICE: "signudoc", TRUSTED_PROXY_HOPS: "2" };

  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": "10.0.0.1, 192.0.2.44, 203.0.113.80" }),
      behindLoadBalancer,
    ),
    "192.0.2.44",
  );
  // Fewer entries than proxies: the request skipped one, so none counts.
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": "192.0.2.44" }),
      behindLoadBalancer,
    ),
    null,
  );
  assert.deepEqual(getClientIpHeaderNames(behindLoadBalancer), [
    CLIENT_IP_REQUEST_HEADER,
  ]);
});

test("a TRUSTED_PROXY_HOPS or CLIENT_IP_HEADER that makes no sense is ignored", () => {
  for (const value of ["0", "-1", "abc", "11", ""]) {
    assert.deepEqual(resolveClientIpSource({ TRUSTED_PROXY_HOPS: value }), {
      hops: 1,
      kind: "forwarded-for",
    });
  }

  assert.deepEqual(resolveClientIpSource({ CLIENT_IP_HEADER: "x real ip" }), {
    hops: 1,
    kind: "forwarded-for",
  });
  assert.deepEqual(
    resolveClientIpSource({
      ...onVercel,
      CLIENT_IP_HEADER: "cf-connecting-ip",
    }),
    { kind: "vercel" },
  );
});

test("the header the proxy writes replaces one the visitor sent", () => {
  const sent = new Headers({
    [CLIENT_IP_REQUEST_HEADER]: "10.9.9.9",
    "x-forwarded-for": "198.51.100.7, 203.0.113.5",
  });

  assert.equal(
    withClientIpHeader(sent, onCloudRun).get(CLIENT_IP_REQUEST_HEADER),
    "203.0.113.5",
  );
  assert.equal(
    withClientIpHeader(
      new Headers({ [CLIENT_IP_REQUEST_HEADER]: "10.9.9.9" }),
      onCloudRun,
    ).has(CLIENT_IP_REQUEST_HEADER),
    false,
  );
  // The headers it was given are left as they were.
  assert.equal(sent.get(CLIENT_IP_REQUEST_HEADER), "10.9.9.9");
});

test("an empty header is passed over, and no header at all gives no address", () => {
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": "203.0.113.5, " }),
      elsewhere,
    ),
    "203.0.113.5",
  );
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": " ", "x-real-ip": "203.0.113.5" }),
      onVercel,
    ),
    "203.0.113.5",
  );
  assert.equal(getClientIpAddress(new Headers(), onVercel), null);
  assert.equal(getClientIpAddress(new Headers(), elsewhere), null);
});

test("a user agent header with no value counts as no user agent", () => {
  assert.equal(getRequestUserAgent(new Headers()), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "" })), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "  " })), null);
  assert.equal(
    getRequestUserAgent(new Headers({ "user-agent": " curl/8.5.0 " })),
    "curl/8.5.0",
  );
});

test("the audit schema accepts what an empty user agent header gives", () => {
  const userAgent = getRequestUserAgent(new Headers({ "user-agent": "" }));

  assert.ok(
    auditEventRecordSchema.shape.userAgent.safeParse(userAgent).success,
  );
});
