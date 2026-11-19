// Finding an organization's logo in its website's HTML, and turning what
// is found into something the install can store as its logo
// (brand-logo.ts takes PNG, JPEG or WebP up to 512 KB). Pure: the fetching
// is in logo-fetch.ts.

export type LogoSource = "apple-touch-icon" | "favicon" | "icon" | "og:image";

export type LogoCandidate = {
  /** The largest size the page declares, in pixels, or null. */
  size: number | null;
  source: LogoSource;
  /** The declared or guessed type, such as "image/png", or null. */
  type: string | null;
  url: string;
};

const MAX_CANDIDATES = 6;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

// What HTML makes of a numeric reference that is not a character.
function fromCodePoint(code: number): string {
  return Number.isNaN(code) ||
    code === 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
    ? "\uFFFD"
    : String.fromCodePoint(code);
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }

      if (entity.startsWith("#")) {
        return fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }

      return ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

/** The attributes of one tag, names lowercased. */
export function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern =
    /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of text.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();

    if (!attributes.has(name)) {
      attributes.set(
        name,
        decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim(),
      );
    }
  }

  return attributes;
}

/** The largest of "16x16 32x32", or null for "any" or nothing. */
export function largestSize(sizes: string | undefined): number | null {
  let largest: number | null = null;

  for (const size of (sizes ?? "").toLowerCase().split(/\s+/)) {
    const match = /^(\d{1,5})x(\d{1,5})$/.exec(size);

    if (match) {
      const value = Math.min(Number(match[1]), Number(match[2]));

      largest = largest === null ? value : Math.max(largest, value);
    }
  }

  return largest;
}

const EXTENSION_TYPES: Record<string, string> = {
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** The image type a URL's extension suggests, or null. */
export function typeFromUrl(url: string): string | null {
  let path: string;

  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }

  const extension = /\.([a-z]+)$/.exec(path)?.[1] ?? "";

  return Object.hasOwn(EXTENSION_TYPES, extension)
    ? EXTENSION_TYPES[extension]!
    : null;
}

function resolveUrl(value: string | undefined, base: URL): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, base);

    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

type Tag = { attributes: Map<string, string>; name: string };

const TAG_NAMES = ["base", "link", "meta"];

/**
 * The base, link and meta tags of a page, in order, skipping comments. One
 * pass with indexOf, so markup that never closes cannot make it slow.
 */
function readTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let position = html.indexOf("<");

  while (position !== -1) {
    if (html.startsWith("<!--", position)) {
      const close = html.indexOf("-->", position + 4);

      if (close === -1) {
        break;
      }

      position = html.indexOf("<", close + 3);
      continue;
    }

    const name = TAG_NAMES.find(
      (candidate) =>
        html
          .slice(position + 1, position + 1 + candidate.length)
          .toLowerCase() === candidate &&
        /[\s/>]/.test(html.charAt(position + 1 + candidate.length)),
    );

    if (name) {
      const close = html.indexOf(">", position);

      if (close === -1) {
        break;
      }

      tags.push({
        attributes: parseAttributes(
          html.slice(position + 1 + name.length, close),
        ),
        name,
      });
      position = html.indexOf("<", close + 1);
      continue;
    }

    position = html.indexOf("<", position + 1);
  }

  return tags;
}

/**
 * Every logo the page points at: touch icons, icons, the og:image, and
 * /favicon.ico, in the order the page has them. The first <base href>
 * applies to the whole page; /favicon.ico is on the page's own origin.
 */
export function findLogoCandidates(
  html: string,
  pageUrl: string,
): LogoCandidate[] {
  const page = new URL(pageUrl);
  const tags = readTags(html);
  let base = page;

  for (const tag of tags) {
    if (tag.name !== "base") {
      continue;
    }

    const href = resolveUrl(tag.attributes.get("href"), page);

    if (href) {
      base = new URL(href);
      break;
    }
  }

  const found: LogoCandidate[] = [];

  for (const { attributes, name: tag } of tags) {
    if (tag === "base") {
      continue;
    }

    if (tag === "meta") {
      const property = (
        attributes.get("property") ??
        attributes.get("name") ??
        ""
      ).toLowerCase();

      if (property === "og:image" || property === "og:image:secure_url") {
        const url = resolveUrl(attributes.get("content"), base);

        if (url) {
          found.push({
            size: null,
            source: "og:image",
            type: typeFromUrl(url),
            url,
          });
        }
      }

      continue;
    }

    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const touch =
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed");

    // mask-icon is a one-colour outline for Safari's pinned tabs.
    if (!touch && !rel.includes("icon")) {
      continue;
    }

    const url = resolveUrl(attributes.get("href"), base);

    if (!url) {
      continue;
    }

    const declared = attributes.get("type")?.toLowerCase() || null;

    found.push({
      // A touch icon with no size is 180 pixels on every current device.
      size: largestSize(attributes.get("sizes")) ?? (touch ? 180 : null),
      source: touch ? "apple-touch-icon" : "icon",
      type: declared ?? typeFromUrl(url),
      url,
    });
  }

  found.push({
    size: null,
    source: "favicon",
    type: "image/x-icon",
    url: new URL("/favicon.ico", page).toString(),
  });

  return found;
}

/**
 * How good a logo a candidate is likely to make: PNG and other raster
 * images first, largest first; then SVG (shown, but not stored); then the
 * og:image, which is often a banner; then .ico files.
 */
function group(candidate: LogoCandidate): number {
  if (
    candidate.type === "image/x-icon" ||
    candidate.type === "image/vnd.microsoft.icon"
  ) {
    return 3;
  }

  if (candidate.source === "og:image") {
    return 2;
  }

  if (candidate.type === "image/svg+xml") {
    return 1;
  }

  return 0;
}

/** The candidates worth fetching, best first, each address once. */
export function rankLogoCandidates(
  candidates: readonly LogoCandidate[],
): LogoCandidate[] {
  const seen = new Set<string>();

  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        group(a.candidate) - group(b.candidate) ||
        (b.candidate.size ?? 0) - (a.candidate.size ?? 0) ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate)
    .filter((candidate) => {
      if (seen.has(candidate.url) || candidate.type === "image/gif") {
        return false;
      }

      seen.add(candidate.url);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array, offset = 0): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[offset + index] === value);
}

/** A PNG's width and height from its header, or null. */
export function pngDimensions(
  bytes: Uint8Array,
): { height: number; width: number } | null {
  if (bytes.length < 24 || !isPng(bytes)) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return { height: view.getUint32(20), width: view.getUint32(16) };
}

/**
 * The largest PNG inside a .ico file. Icons made since Windows Vista keep
 * their large sizes as PNG; older ones hold only bitmaps, which are not
 * taken (null).
 */
export function extractPngFromIco(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 6) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    return null;
  }

  const count = view.getUint16(4, true);
  let best: { data: Uint8Array; size: number } | null = null;

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;

    if (entry + 16 > bytes.length) {
      break;
    }

    const size = bytes[entry] === 0 ? 256 : bytes[entry]!;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);

    if (
      length < PNG_SIGNATURE.length ||
      offset + length > bytes.length ||
      !isPng(bytes, offset)
    ) {
      continue;
    }

    if (!best || size > best.size) {
      best = { data: bytes.slice(offset, offset + length), size };
    }
  }

  return best?.data ?? null;
}
