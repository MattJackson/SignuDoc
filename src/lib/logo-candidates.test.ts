import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractPngFromIco,
  findLogoCandidates,
  largestSize,
  parseAttributes,
  pngDimensions,
  rankLogoCandidates,
  typeFromUrl,
} from "./logo-candidates.ts";

const PAGE = "https://www.example.com/en/";

test("attributes are read with any quoting, and entities decoded", () => {
  const attributes = parseAttributes(
    ` rel="icon" HREF='/a.png?x=1&amp;y=2' sizes=32x32 hidden`,
  );

  assert.equal(attributes.get("rel"), "icon");
  assert.equal(attributes.get("href"), "/a.png?x=1&y=2");
  assert.equal(attributes.get("sizes"), "32x32");
  assert.equal(attributes.get("hidden"), "");
});

test("the largest declared size is taken, and 'any' counts as none", () => {
  assert.equal(largestSize("16x16 32x32 192x192"), 192);
  assert.equal(largestSize("any"), null);
  assert.equal(largestSize(undefined), null);
  assert.equal(largestSize("180x120"), 120);
});

test("the type is guessed from the extension", () => {
  assert.equal(typeFromUrl("https://a.example/x/logo.PNG?v=2"), "image/png");
  assert.equal(typeFromUrl("https://a.example/icon.svg"), "image/svg+xml");
  assert.equal(typeFromUrl("https://a.example/favicon.ico"), "image/x-icon");
  assert.equal(typeFromUrl("https://a.example/icon"), null);
  assert.equal(typeFromUrl("https://a.example/x.constructor"), null);
});

test("touch icons, icons, og:image and /favicon.ico are found and resolved", () => {
  const html = `<!doctype html><html><head>
    <!-- <link rel="icon" href="/commented-out.png"> -->
    <link rel="stylesheet" href="/site.css">
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/32.png">
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="mask-icon" href="/mask.svg" color="#000">
    <link rel="apple-touch-icon" href="../touch.png">
    <link rel="icon" href="/logo.svg" type="image/svg+xml" sizes="any">
    <meta property="og:image" content="https://www.example.com/share.jpg">
    <link rel="icon" href="javascript:alert(1)">
  </head><body><link rel="icon" href="/late.png" sizes="512x512"></body></html>`;
  const found = findLogoCandidates(html, PAGE);

  assert.deepEqual(
    found.map((candidate) => [candidate.source, candidate.url, candidate.size]),
    [
      ["icon", "https://www.example.com/icons/32.png", 32],
      ["icon", "https://www.example.com/favicon.ico", null],
      ["apple-touch-icon", "https://www.example.com/touch.png", 180],
      ["icon", "https://www.example.com/logo.svg", null],
      ["og:image", "https://www.example.com/share.jpg", null],
      ["icon", "https://www.example.com/late.png", 512],
      ["favicon", "https://www.example.com/favicon.ico", null],
    ],
  );
});

test("a <base> changes where relative addresses point", () => {
  const found = findLogoCandidates(
    `<base href="https://cdn.example.com/assets/"><link rel="icon" href="i.png">`,
    PAGE,
  );

  assert.equal(found[0]!.url, "https://cdn.example.com/assets/i.png");
  assert.equal(found.at(-1)!.url, "https://cdn.example.com/favicon.ico");
});

test("the largest PNG comes first, then SVG, then og:image, then .ico, each once", () => {
  const html = `
    <link rel="icon" type="image/png" sizes="32x32" href="/32.png">
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
    <link rel="icon" href="/logo.svg">
    <meta name="og:image" content="/share.png">
    <link rel="icon" href="/anim.gif">
    <link rel="icon" sizes="192x192" href="/192.png">`;
  const ranked = rankLogoCandidates(findLogoCandidates(html, PAGE));

  assert.deepEqual(
    ranked.map((candidate) => new URL(candidate.url).pathname),
    [
      "/192.png",
      "/touch.png",
      "/32.png",
      "/logo.svg",
      "/share.png",
      "/favicon.ico",
    ],
  );
});

test("a page with nothing still offers /favicon.ico", () => {
  const ranked = rankLogoCandidates(findLogoCandidates("", PAGE));

  assert.deepEqual(
    ranked.map((candidate) => candidate.url),
    ["https://www.example.com/favicon.ico"],
  );
});

function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);

  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  const view = new DataView(bytes.buffer);

  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);

  return bytes;
}

function ico(entries: Array<{ data: Uint8Array; size: number }>): Uint8Array {
  const header = 6 + entries.length * 16;
  const total =
    header + entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let offset = header;

  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;

    bytes[at] = entry.size >= 256 ? 0 : entry.size;
    bytes[at + 1] = entry.size >= 256 ? 0 : entry.size;
    view.setUint32(at + 8, entry.data.length, true);
    view.setUint32(at + 12, offset, true);
    bytes.set(entry.data, offset);
    offset += entry.data.length;
  });

  return bytes;
}

test("a PNG's size is read from its header", () => {
  assert.deepEqual(pngDimensions(png(180, 160)), { height: 160, width: 180 });
  assert.equal(pngDimensions(new Uint8Array([1, 2, 3])), null);
});

test("the largest PNG inside an .ico is taken, and bitmap-only icons give nothing", () => {
  const small = png(32, 32);
  const large = png(256, 256, 4);
  const bitmap = new Uint8Array(40).fill(7);
  const extracted = extractPngFromIco(
    ico([
      { data: bitmap, size: 16 },
      { data: small, size: 32 },
      { data: large, size: 256 },
    ]),
  );

  assert.deepEqual(extracted, large);
  assert.equal(extractPngFromIco(ico([{ data: bitmap, size: 16 }])), null);
  assert.equal(extractPngFromIco(png(16, 16)), null);
  assert.equal(extractPngFromIco(new Uint8Array(3)), null);
});
