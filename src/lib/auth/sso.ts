import { readEnv, type EnvSource } from "../utils/env.ts";
import { googleUrl } from "../integrations/google/endpoints.ts";
import { parseEmailDomainList } from "../signup-policy.ts";

// Single sign-on with the organization's own identity provider, over OpenID
// Connect: Google Workspace, Okta, Microsoft Entra ID, or any other provider
// that publishes /.well-known/openid-configuration.
//
// It can be set in two places. The environment (SSO_ISSUER, SSO_CLIENT_ID
// and SSO_CLIENT_SECRET, all three) always wins; otherwise an administrator
// can set the same three in the app (Settings, Google Workspace), where the
// client secret is stored encrypted (integration-settings.ts). Either way it
// is off until all three are given.
//
// People who sign in this way for the first time get an account under the
// install's sign-up rule (Settings, Organization), the same as a sign-up with
// a password, so the email domain limit holds for both. Someone who already
// has an account with that email address is signed in to it.
//
// Turning password sign-in off (PASSWORD_SIGN_IN=off, or the same choice in
// the app) then lets the identity provider decide who gets in, and its own
// rules (MFA, offboarding) apply. The addresses kept as a way in for an
// administrator when the provider is down keep their password.
//
// With Google as the provider, sign-in is also held to the organization's
// Google Workspace: the hd claim in Google's ID token names the Workspace an
// account belongs to, and has to be one of the allowed domains. That holds
// even if the OAuth client were set to External by mistake, which would let
// any Google account reach the consent screen.

/** The provider id in Better Auth: its callback is /api/auth/callback/sso. */
export const SSO_PROVIDER_ID = "sso";

export const GOOGLE_ISSUER = "https://accounts.google.com";

/** Where Better Auth expects the provider to send people back to. */
export function ssoRedirectPath(): string {
  return `/api/auth/callback/${SSO_PROVIDER_ID}`;
}

export type SsoConfig = {
  clientId: string;
  clientSecret: string;
  /** The provider's discovery document. */
  discoveryUrl: string;
  /** Google is the provider, so the Workspace checks apply. */
  google: boolean;
  issuer: string;
  /** What the button says after "Continue with". */
  name: string;
  /** Where the setting comes from: environment variables or the app. */
  source: "env" | "settings";
};

export type PasswordSignInPolicy = {
  /** Lowercased addresses that may still use a password when it is off. */
  allowedEmails: string[];
  enabled: boolean;
  /** Where the choice comes from. */
  source: "default" | "env" | "settings";
};

/** The stored values these settings read, by name (integration-settings.ts). */
export type StoredSignInSettings = Readonly<
  Partial<
    Record<
      | "google.workspaceDomains"
      | "sso.clientId"
      | "sso.clientSecret"
      | "sso.issuer"
      | "sso.name"
      | "sso.passwordAllowedEmails"
      | "sso.passwordSignIn",
      string
    >
  >
>;

export function normalizeIssuer(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return null;
  }

  // The issuer may be given with its discovery path, or with a trailing slash.
  return url
    .toString()
    .replace(/\/\.well-known\/openid-configuration\/?$/, "")
    .replace(/\/+$/, "");
}

export function isGoogleIssuer(issuer: string): boolean {
  return normalizeIssuer(issuer) === GOOGLE_ISSUER;
}

/** True when any SSO_* variable is set, so the environment decides. */
export function ssoSetInEnvironment(env: EnvSource = process.env): boolean {
  return Boolean(
    readEnv(env, "SSO_ISSUER") ||
    readEnv(env, "SSO_CLIENT_ID") ||
    readEnv(env, "SSO_CLIENT_SECRET"),
  );
}

/**
 * The install's single sign-on settings, or null when it is not set up.
 * A partial or broken setting is reported once and treated as not set up,
 * so a typo cannot stop password sign-in from working.
 */
export function readSsoConfig(
  env: EnvSource = process.env,
  stored: StoredSignInSettings | null = null,
): SsoConfig | null {
  const fromEnv = ssoSetInEnvironment(env);
  const rawIssuer = fromEnv
    ? readEnv(env, "SSO_ISSUER")
    : stored?.["sso.issuer"]?.trim();
  const clientId = fromEnv
    ? readEnv(env, "SSO_CLIENT_ID")
    : stored?.["sso.clientId"]?.trim();
  const clientSecret = fromEnv
    ? readEnv(env, "SSO_CLIENT_SECRET")
    : stored?.["sso.clientSecret"]?.trim();

  if (!rawIssuer && !clientId && !clientSecret) {
    return null;
  }

  if (!rawIssuer || !clientId || !clientSecret) {
    if (fromEnv) {
      warnOnce(
        "SSO is turned off: set all three of SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET.",
      );
    }

    return null;
  }

  const issuer = normalizeIssuer(rawIssuer);

  if (!issuer) {
    warnOnce("SSO is turned off: the issuer must be an https:// URL.");
    return null;
  }

  const google = issuer === GOOGLE_ISSUER;
  const name =
    (fromEnv ? readEnv(env, "SSO_NAME") : stored?.["sso.name"]?.trim()) ||
    (google ? "Google" : "single sign-on");

  return {
    clientId,
    clientSecret,
    // Google's discovery document can be served by a test stand-in
    // (integrations/google/endpoints.ts); the issuer stays Google's, so the
    // ID tokens are checked exactly as in production.
    discoveryUrl: googleUrl(`${issuer}/.well-known/openid-configuration`, env),
    google,
    issuer,
    name,
    source: fromEnv ? "env" : "settings",
  };
}

function parseAddressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether password sign-in is on. It can only be turned off while single
 * sign-on is set up, so nobody can be left with no way in at all.
 * PASSWORD_SIGN_IN, when set, wins over the choice made in the app.
 */
export function readPasswordSignInPolicy(
  env: EnvSource = process.env,
  stored: StoredSignInSettings | null = null,
): PasswordSignInPolicy {
  const envChoice = readEnv(env, "PASSWORD_SIGN_IN")?.toLowerCase();
  const storedChoice = stored?.["sso.passwordSignIn"]?.trim().toLowerCase();
  const source = envChoice ? "env" : storedChoice ? "settings" : "default";
  const choice = envChoice ?? storedChoice;
  const off = choice === "off" && readSsoConfig(env, stored) !== null;
  const allowed =
    source === "env"
      ? readEnv(env, "PASSWORD_SIGN_IN_ALLOWED_EMAILS")
      : stored?.["sso.passwordAllowedEmails"];

  return {
    allowedEmails: off ? parseAddressList(allowed) : [],
    enabled: !off,
    source,
  };
}

/** Whether this address may sign in, sign up or reset with a password. */
export function mayUsePassword(
  policy: PasswordSignInPolicy,
  email: string,
): boolean {
  return (
    policy.enabled || policy.allowedEmails.includes(email.trim().toLowerCase())
  );
}

export type WorkspaceDomains = {
  domains: string[];
  /**
   * A list was set but none of its entries is a domain. Nobody is let in
   * until it is corrected, rather than everyone.
   */
  invalid?: true;
  /**
   * Where the list comes from: GOOGLE_WORKSPACE_DOMAINS, the app's Google
   * Workspace settings, or the sign-up rule's domains. "none" means no list
   * is known, so any Google Workspace account passes the check but a
   * personal Google account does not.
   */
  source: "env" | "none" | "settings" | "signup_rule";
};

/** The Workspace domains Google sign-in is held to. */
export function resolveWorkspaceDomains({
  env = process.env,
  signupDomains,
  stored,
}: {
  env?: EnvSource;
  /** The sign-up rule's domains, when sign-up is limited to domains. */
  signupDomains: readonly string[];
  stored: StoredSignInSettings | null;
}): WorkspaceDomains {
  const fromEnv = readEnv(env, "GOOGLE_WORKSPACE_DOMAINS");

  if (fromEnv) {
    const { domains } = parseEmailDomainList(fromEnv);

    if (domains.length === 0) {
      warnOnce(
        "GOOGLE_WORKSPACE_DOMAINS has no valid domain, so Google sign-in lets no one in until it is corrected.",
      );

      return { domains, invalid: true, source: "env" };
    }

    return { domains, source: "env" };
  }

  const fromSettings = stored?.["google.workspaceDomains"];

  if (fromSettings?.trim()) {
    const { domains } = parseEmailDomainList(fromSettings);

    return domains.length === 0
      ? { domains, invalid: true, source: "settings" }
      : { domains, source: "settings" };
  }

  if (signupDomains.length > 0) {
    return {
      domains: parseEmailDomainList(signupDomains).domains,
      source: "signup_rule",
    };
  }

  return { domains: [], source: "none" };
}

/**
 * What is added to Google's sign-in link: the hd hint, which makes Google
 * offer only accounts in the organization's Workspace. "*" asks for any
 * Workspace account when there are several domains (or none known). The
 * hint is only a hint; the ID token is checked on the way back.
 * https://developers.google.com/identity/openid-connect/openid-connect#hd-param
 */
export function googleAuthorizationParams(
  domains: readonly string[],
): Record<string, string> {
  return { hd: domains.length === 1 ? domains[0]! : "*" };
}

export type WorkspaceAccountDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "workspace_account_required" | "workspace_domain_not_allowed";
      message: string;
    };

/**
 * Checks the hd claim of a verified Google ID token. A personal Google
 * account has none. An account in another organization's Workspace has that
 * organization's domain.
 */
export function checkWorkspaceAccount(
  profile: Readonly<Record<string, unknown>> | undefined,
  allowed: readonly string[] | WorkspaceDomains,
): WorkspaceAccountDecision {
  const domains = Array.isArray(allowed)
    ? allowed
    : (allowed as WorkspaceDomains).domains;
  const noneAllowed =
    !Array.isArray(allowed) && (allowed as WorkspaceDomains).invalid === true;
  const claim = profile?.hd;
  const hd = typeof claim === "string" ? claim.trim().toLowerCase() : "";

  if (!hd) {
    return {
      allowed: false,
      code: "workspace_account_required",
      message: "Sign in with your organization's Google Workspace account.",
    };
  }

  if (noneAllowed || (domains.length > 0 && !domains.includes(hd))) {
    return {
      allowed: false,
      code: "workspace_domain_not_allowed",
      message: "This Google account is not in this organization's Workspace.",
    };
  }

  return { allowed: true };
}

const warned = new Set<string>();

function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[auth] ${message}`);
  }
}
