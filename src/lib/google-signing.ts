import {
  loadSignInSettings,
  resolveSignInConfig,
  type SignInConfig,
} from "./auth/sign-in-settings.ts";
import {
  getIntegrationSettings,
  type IntegrationSettings,
} from "./integration-settings.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// Employees sign with Google: when a signer's address is in one of the
// organization's Workspace domains and Google sign-in is set up, the
// signing page can ask them to be signed in to this site with Google, as
// that same address, before they open the document.
//
// - off: nothing changes.
// - offer: such a signer may confirm who they are with Google. It is
//   optional, and when they do it is recorded in the evidence.
// - require: such a signer must, before the document opens. Decided when
//   the envelope is sent and kept on the signer's row
//   (signers.require_google_sign_in), so a later change of the setting
//   does not change the rules an envelope went out under.
//
// It is always on top of what the sender asked for. It never stands in for
// an access code or an emailed code: those prove something else (a code
// shared another way, the mailbox right now), and the sender chose them.
//
// Signers outside the Workspace domains are never asked, and neither is
// anyone on a Part 11 envelope, who signs with their own account and
// password already. With no Workspace domains known there is no way to
// tell an employee from a customer, so the setting does nothing.

export const googleSigningModes = ["off", "offer", "require"] as const;
export type GoogleSigningMode = (typeof googleSigningModes)[number];

export type GoogleSigningSetting = {
  mode: GoogleSigningMode;
  source: "default" | "env" | "settings";
};

export function parseGoogleSigningMode(
  value: string | null | undefined,
): GoogleSigningMode | null {
  const normalized = value?.trim().toLowerCase();

  return (googleSigningModes as readonly string[]).includes(normalized ?? "")
    ? (normalized as GoogleSigningMode)
    : null;
}

/** GOOGLE_SIGNING wins over the stored setting; off when neither is set. */
export function readGoogleSigningSetting(
  env: EnvSource = process.env,
  stored: Pick<IntegrationSettings, "people.googleSigning"> | null = null,
): GoogleSigningSetting {
  const fromEnv = parseGoogleSigningMode(readEnv(env, "GOOGLE_SIGNING"));

  if (fromEnv) {
    return { mode: fromEnv, source: "env" };
  }

  const fromSettings = parseGoogleSigningMode(stored?.["people.googleSigning"]);

  if (fromSettings) {
    return { mode: fromSettings, source: "settings" };
  }

  return { mode: "off", source: "default" };
}

export type GoogleSigningPolicy = {
  /**
   * Google sign-in is set up and the Workspace domains are known, so the
   * setting can apply. False means it does nothing, whatever it says.
   */
  available: boolean;
  domains: string[];
  mode: GoogleSigningMode;
  source: GoogleSigningSetting["source"];
  /** The site's sign-in is Google's, whatever the domains. */
  ssoIsGoogle: boolean;
};

export function resolveGoogleSigningPolicy(
  signIn: Pick<SignInConfig, "sso" | "workspaceDomains">,
  setting: GoogleSigningSetting,
): GoogleSigningPolicy {
  const domains = signIn.workspaceDomains.domains;

  return {
    available: signIn.sso?.google === true && domains.length > 0,
    domains,
    mode: setting.mode,
    source: setting.source,
    ssoIsGoogle: signIn.sso?.google === true,
  };
}

/**
 * The setting in force. A failed read of the stored settings is an error,
 * not "off": a caller that records a requirement (sending, correcting a
 * signer) must not drop it because the database hiccuped.
 */
export async function loadGoogleSigningPolicy(
  env: EnvSource = process.env,
): Promise<GoogleSigningPolicy> {
  const [signInSettings, stored] = await Promise.all([
    loadSignInSettings(env),
    getIntegrationSettings(env),
  ]);

  return resolveGoogleSigningPolicy(
    resolveSignInConfig(signInSettings, env),
    readGoogleSigningSetting(env, stored),
  );
}

/**
 * For the signing page, which only decides what to offer and records
 * nothing: when the settings cannot be read, Google signing is left off
 * for now rather than failing the page.
 */
export async function loadGoogleSigningPolicyOrOff(
  env: EnvSource = process.env,
): Promise<GoogleSigningPolicy> {
  try {
    return await loadGoogleSigningPolicy(env);
  } catch (error) {
    console.error("Could not read the Google signing setting:", error);

    return {
      available: false,
      domains: [],
      mode: "off",
      source: "default",
      ssoIsGoogle: false,
    };
  }
}

/** The address's domain is one of the Workspace domains. */
export function isWorkspaceAddress(
  email: string,
  domains: readonly string[],
): boolean {
  const at = email.lastIndexOf("@");

  if (at <= 0) {
    return false;
  }

  return domains.includes(
    email
      .slice(at + 1)
      .trim()
      .toLowerCase(),
  );
}

/** What the setting means for one signer. */
export function googleSigningFor(
  policy: GoogleSigningPolicy,
  signer: { email: string },
  envelope: { part11?: boolean | null },
): GoogleSigningMode {
  if (
    !policy.available ||
    policy.mode === "off" ||
    envelope.part11 ||
    !isWorkspaceAddress(signer.email, policy.domains)
  ) {
    return "off";
  }

  return policy.mode;
}
