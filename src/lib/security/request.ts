type IpEnv = Record<string, string | undefined>;

/**
 * The header src/proxy.ts writes on every request with the address
 * getClientIpAddress found, after removing any value the visitor sent.
 * Better Auth reads it off Vercel (see getClientIpHeaderNames), because it
 * cannot pick an address out of the middle of X-Forwarded-For itself.
 */
export const CLIENT_IP_REQUEST_HEADER = "x-signudoc-client-ip";

const MAX_TRUSTED_PROXY_HOPS = 10;

/**
 * Where the visitor's address comes from.
 *
 * - "vercel": on Vercel, x-vercel-forwarded-for and x-real-ip are written by
 *   Vercel itself and cannot be set by the visitor, so they come first.
 *   https://vercel.com/docs/headers/request-headers
 * - "header": CLIENT_IP_HEADER names one header that the proxy in front of
 *   the app always overwrites, such as cf-connecting-ip behind Cloudflare or
 *   x-real-ip behind an nginx that sets it. Nothing else is read.
 * - "forwarded-for": everywhere else, X-Forwarded-For, counted from the
 *   right. Every proxy appends the address it saw the request come from, so
 *   only the entries added by proxies you run (or your platform runs) can be
 *   trusted; whatever is to the left of them came from the visitor.
 *   TRUSTED_PROXY_HOPS says how many proxies append an entry, and the entry
 *   that many places from the right is the visitor. It is 1 unless set.
 *
 * On Cloud Run (K_SERVICE is set) the default of 1 is the right one for
 * requests to the service's own URL or a domain mapping: Google's front end
 * appends the address the connection came from to whatever X-Forwarded-For
 * the visitor sent, so the last entry is the visitor and everything before
 * it is the visitor's own text. Google describes the header as the list of
 * addresses the request was routed through, later entries being the
 * proxies (https://cloud.google.com/functions/docs/reference/headers,
 * which covers Cloud Run functions). Behind a Google Cloud external
 * Application Load Balancer, the load balancer appends two entries,
 * "CLIENT_IP,LOAD_BALANCER_IP", and documents that only those two can be
 * trusted, so set TRUSTED_PROXY_HOPS=2 there
 * (https://cloud.google.com/load-balancing/docs/https, "X-Forwarded-For
 * header").
 *
 * cf-connecting-ip and x-real-ip are never read unless CLIENT_IP_HEADER
 * names them: on a host that is not behind that proxy anyone can send them.
 */
export type ClientIpSource =
  | { kind: "vercel" }
  | { kind: "header"; name: string }
  | { hops: number; kind: "forwarded-for" };

const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;

export function resolveClientIpSource(
  env: IpEnv = process.env,
): ClientIpSource {
  if (env.VERCEL === "1") {
    return { kind: "vercel" };
  }

  const headerName = env.CLIENT_IP_HEADER?.trim().toLowerCase();

  if (headerName && HEADER_NAME_PATTERN.test(headerName)) {
    return { kind: "header", name: headerName };
  }

  const hops = Number.parseInt(env.TRUSTED_PROXY_HOPS?.trim() ?? "", 10);

  return {
    hops:
      Number.isInteger(hops) && hops >= 1 && hops <= MAX_TRUSTED_PROXY_HOPS
        ? hops
        : 1,
    kind: "forwarded-for",
  };
}

function addressList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function firstAddress(value: string | null): string | null {
  return addressList(value)[0] ?? null;
}

/**
 * The headers Better Auth reads the visitor's address from, for its rate
 * limits and sessions. Better Auth only trusts a header that holds a single
 * address, so off Vercel it reads the one src/proxy.ts writes first. The
 * header after it is only for code that calls Better Auth without going
 * through the proxy (the database tests), and is one that gives the same
 * answer as getClientIpAddress whenever it holds a single address.
 */
export function getClientIpHeaderNames(env: IpEnv = process.env): string[] {
  const source = resolveClientIpSource(env);

  if (source.kind === "vercel") {
    return ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"];
  }

  if (source.kind === "header") {
    return [CLIENT_IP_REQUEST_HEADER, source.name];
  }

  return source.hops === 1
    ? [CLIENT_IP_REQUEST_HEADER, "x-forwarded-for"]
    : [CLIENT_IP_REQUEST_HEADER];
}

export function getClientIpAddress(
  headers: Headers,
  env: IpEnv = process.env,
): string | null {
  const source = resolveClientIpSource(env);

  if (source.kind === "vercel") {
    for (const name of [
      "x-vercel-forwarded-for",
      "x-real-ip",
      "x-forwarded-for",
    ]) {
      const address = firstAddress(headers.get(name));

      if (address) {
        return address;
      }
    }

    return null;
  }

  if (source.kind === "header") {
    return firstAddress(headers.get(source.name));
  }

  // Fewer entries than trusted proxies means the request did not come
  // through all of them, so none of the entries can be trusted.
  const entries = addressList(headers.get("x-forwarded-for"));

  return entries[entries.length - source.hops] ?? null;
}

/**
 * A copy of the request headers with CLIENT_IP_REQUEST_HEADER set to the
 * visitor's address, or removed when there is none, so a visitor cannot
 * send their own.
 */
export function withClientIpHeader(
  headers: Headers,
  env: IpEnv = process.env,
): Headers {
  const result = new Headers(headers);
  const address = getClientIpAddress(headers, env);

  result.delete(CLIENT_IP_REQUEST_HEADER);

  if (address) {
    result.set(CLIENT_IP_REQUEST_HEADER, address);
  }

  return result;
}

export function getRequestUserAgent(headers: Headers): string | null {
  // A header sent with no value reads as "", which the audit schema
  // rejects; it counts as no user agent at all.
  return headers.get("user-agent")?.trim() || null;
}

/** Who made a request, as the audit trail records it. */
export type RequestClient = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function getRequestClient(
  headers: Headers | null | undefined,
  env: IpEnv = process.env,
): { ipAddress: string | null; userAgent: string | null } {
  if (!headers) {
    return { ipAddress: null, userAgent: null };
  }

  return {
    ipAddress: getClientIpAddress(headers, env),
    userAgent: getRequestUserAgent(headers),
  };
}

export function getRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
