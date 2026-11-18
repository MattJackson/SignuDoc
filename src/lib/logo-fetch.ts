import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

// Fetching an organization's logo from its own website, on the server, so
// first-run setup can offer it. The URL comes from the site's HTML, which
// someone else controls, so every request is held to the same rules:
//
// - https on the default port, to a host that is one of the install's own
//   domains or a subdomain of one (never an IP address);
// - the host resolves only to public addresses, and the connection is made
//   to the address that was checked, so DNS cannot be switched in between;
// - at most 3 redirects, each checked the same way;
// - 5 seconds for the whole chain, and a size cap on what is read.

export const LOGO_FETCH_TIMEOUT_MS = 5000;
export const MAX_LOGO_HTML_BYTES = 1024 * 1024;
export const MAX_LOGO_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export const LOGO_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/webp",
] as const;

const HTML_TYPES = ["text/html", "application/xhtml+xml"];

// Addresses that are not on the public internet: private networks,
// loopback, link-local, carrier-grade NAT, documentation and benchmarking
// ranges, multicast, reserved, and IPv6 forms that can carry an IPv4
// address (mapped, NAT64, 6to4, Teredo).
const BLOCKED = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** True for an IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 0) {
    return false;
  }

  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * True when the host is one of the domains, or a subdomain of one. IP
 * addresses never are, whatever they point at.
 */
export function isAllowedLogoHost(
  host: string,
  domains: readonly string[],
): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");

  if (!name || isIP(name.replace(/^\[|\]$/g, "")) !== 0) {
    return false;
  }

  return domains.some((domain) => {
    const allowed = domain.trim().toLowerCase().replace(/\.$/, "");

    return allowed !== "" && (name === allowed || name.endsWith(`.${allowed}`));
  });
}

export class LogoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoFetchError";
  }
}

/** Why a URL cannot be fetched, or null when it can. */
export function refuseLogoUrl(
  url: URL,
  domains: readonly string[],
): string | null {
  if (url.protocol !== "https:") {
    return "Only https addresses are fetched.";
  }

  if (url.port !== "" && url.port !== "443") {
    return "Only the standard https port is used.";
  }

  if (url.username || url.password) {
    return "Addresses with a user name are not fetched.";
  }

  if (!isAllowedLogoHost(url.hostname, domains)) {
    return `${url.hostname} is not one of this site's domains.`;
  }

  return null;
}

type Lookup = typeof dnsLookup;

/** A DNS lookup that refuses names pointing anywhere but the public internet. */
function guardedLookup(lookup: Lookup) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }

      const list = addresses as LookupAddress[];

      if (
        list.length === 0 ||
        list.some((entry) => !isPublicAddress(entry.address))
      ) {
        const refused: NodeJS.ErrnoException = new Error(
          `${hostname} does not resolve to a public address.`,
        );

        refused.code = "ELOGOPRIVATE";
        callback(refused, []);
        return;
      }

      if (options.all) {
        callback(null, list);
      } else {
        callback(null, list[0]!.address, list[0]!.family);
      }
    });
  };
}

type RawResponse =
  | { kind: "redirect"; location: string }
  | { bytes: Uint8Array; contentType: string; kind: "body" };

function baseType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function requestOnce(
  url: URL,
  input: {
    accept: readonly string[];
    lookup: Lookup;
    maxBytes: number;
    signal: AbortSignal;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        headers: {
          accept: input.accept.join(", "),
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0 (compatible; SignuDoc logo finder)",
        },
        hostname: url.hostname,
        lookup: guardedLookup(input.lookup) as never,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        port: 443,
        servername: url.hostname,
        signal: input.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400) {
          response.resume();

          const location = response.headers.location;

          if (!location) {
            reject(new LogoFetchError(`${url.host} redirected nowhere.`));
            return;
          }

          resolve({ kind: "redirect", location });
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new LogoFetchError(`${url.host} answered ${String(status)}.`));
          return;
        }

        const contentType = baseType(response.headers["content-type"]);

        if (!input.accept.includes(contentType)) {
          response.resume();
          reject(
            new LogoFetchError(
              `${url.pathname} is ${contentType || "of no stated type"}, not an image this site takes.`,
            ),
          );
          return;
        }

        const declared = Number(response.headers["content-length"] ?? "0");

        if (Number.isFinite(declared) && declared > input.maxBytes) {
          response.destroy();
          reject(new LogoFetchError(`${url.pathname} is too large.`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;

        response.on("data", (chunk: Buffer) => {
          total += chunk.length;

          if (total > input.maxBytes) {
            response.destroy();
            request.destroy();
            reject(new LogoFetchError(`${url.pathname} is too large.`));
            return;
          }

          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentType,
            kind: "body",
          }),
        );
        response.on("error", reject);
      },
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ELOGOPRIVATE") {
        reject(new LogoFetchError(error.message));
      } else if (error.name === "AbortError") {
        reject(new LogoFetchError(`${url.host} took too long to answer.`));
      } else {
        reject(new LogoFetchError(`${url.host} could not be reached.`));
      }
    });
    request.end();
  });
}

export type LogoFetchResult = {
  bytes: Uint8Array;
  contentType: string;
  /** Where the content came from after any redirects. */
  url: string;
};

/**
 * Fetches a page or an image from one of the install's own domains, under
 * the rules above. Throws LogoFetchError with a message an administrator
 * can read.
 */
export async function fetchFromOwnDomain(
  address: string,
  options: {
    domains: readonly string[];
    kind: "html" | "image";
    lookup?: Lookup;
    timeoutMs?: number;
  },
): Promise<LogoFetchResult> {
  const signal = AbortSignal.timeout(
    options.timeoutMs ?? LOGO_FETCH_TIMEOUT_MS,
  );
  const accept = options.kind === "html" ? HTML_TYPES : LOGO_IMAGE_TYPES;
  const maxBytes =
    options.kind === "html" ? MAX_LOGO_HTML_BYTES : MAX_LOGO_IMAGE_BYTES;
  let url: URL;

  try {
    url = new URL(address);
  } catch {
    throw new LogoFetchError("Not a web address.");
  }

  for (let redirects = 0; ; redirects += 1) {
    const refused = refuseLogoUrl(url, options.domains);

    if (refused) {
      throw new LogoFetchError(refused);
    }

    const response = await requestOnce(url, {
      accept,
      lookup: options.lookup ?? dnsLookup,
      maxBytes,
      signal,
    });

    if (response.kind === "body") {
      return {
        bytes: response.bytes,
        contentType: response.contentType,
        url: url.toString(),
      };
    }

    if (redirects >= MAX_REDIRECTS) {
      throw new LogoFetchError(`${url.host} redirected too many times.`);
    }

    try {
      url = new URL(response.location, url);
    } catch {
      throw new LogoFetchError(`${url.host} redirected to a bad address.`);
    }
  }
}
