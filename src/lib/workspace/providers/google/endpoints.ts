import { readEnv, type EnvSource } from "../../../utils/env.ts";

// Where the app reaches Google. In a deployment these are always Google's own
// addresses. For tests, two variables send them to a stand-in on the same
// machine instead (test-support/fake-google.ts):
//
// - GOOGLE_OAUTH_BASE_URL takes the place of accounts.google.com and
//   oauth2.googleapis.com: sign-in discovery, the authorization page, the
//   token endpoint.
// - GOOGLE_API_BASE_URL takes the place of every other *.googleapis.com
//   API: the Admin SDK directory, Drive, IAM credentials.
//
// The path is kept, so https://admin.googleapis.com/admin/directory/v1/users
// becomes <base>/admin/directory/v1/users. Only a loopback address is taken
// (http://127.0.0.1:<port> or http://localhost:<port>), so a variable set by
// mistake on a real deployment cannot send tokens anywhere else; any other
// value is ignored with a warning.

const OAUTH_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type GoogleBaseVariable =
  "GOOGLE_API_BASE_URL" | "GOOGLE_OAUTH_BASE_URL";

const warned = new Set<string>();

/** The stand-in's base URL from the variable, or null when not set or refused. */
export function readGoogleTestBase(
  env: EnvSource,
  name: GoogleBaseVariable,
): string | null {
  const value = readEnv(env, name);

  if (!value) {
    return null;
  }

  let url: URL | null;

  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(
        `[google] ${name} is ignored: it is for tests and must be a loopback address such as http://127.0.0.1:3102.`,
      );
    }

    return null;
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * A Google URL, or the same path on the test stand-in when one is set. URLs
 * that are not Google's come back unchanged.
 */
export function googleUrl(url: string, env: EnvSource = process.env): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.toLowerCase();
  let name: GoogleBaseVariable | null = null;

  if (OAUTH_HOSTS.has(host)) {
    name = "GOOGLE_OAUTH_BASE_URL";
  } else if (host.endsWith(".googleapis.com")) {
    name = "GOOGLE_API_BASE_URL";
  }

  const base = name ? readGoogleTestBase(env, name) : null;

  return base ? `${base}${parsed.pathname}${parsed.search}` : url;
}

/** How long a call to Google for a small answer may take. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;
/** How long a call that moves a file may take. */
export const GOOGLE_MEDIA_TIMEOUT_MS = 60_000;

/**
 * A signal that aborts after the time, or when the caller's own signal
 * does, so a Google endpoint that stalls cannot hold a request for minutes.
 */
export function googleTimeoutSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal | null,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);

  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}
