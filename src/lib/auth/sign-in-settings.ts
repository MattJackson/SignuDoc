import {
  getIntegrationSettings,
  type IntegrationSettings,
} from "../integration-settings.ts";
import { ServiceConfigurationError } from "../services/service-config.ts";
import { getSettings } from "../settings.ts";
import { type EnvSource } from "../utils/env.ts";
import {
  readPasswordSignInPolicy,
  readSsoConfig,
  resolveWorkspaceDomains,
  type PasswordSignInPolicy,
  type SsoConfig,
  type WorkspaceDomains,
} from "./sso.ts";

// What decides how people sign in, gathered from the environment and from
// what an administrator saved in the app (sso.ts has the rules).

export type SignInSettings = {
  /** The sign-up rule's domains, when sign-up is limited to domains. */
  signupDomains: string[];
  stored: IntegrationSettings;
};

/**
 * Reads the stored sign-in settings. An install with no database yet has
 * none, and falls back on the environment alone.
 */
export async function loadSignInSettings(
  env: EnvSource = process.env,
): Promise<SignInSettings> {
  try {
    const [stored, settings] = await Promise.all([
      getIntegrationSettings(env),
      getSettings(env),
    ]);

    return {
      signupDomains:
        settings.signupMode === "domains" ? settings.allowedEmailDomains : [],
      stored,
    };
  } catch (error) {
    if (error instanceof ServiceConfigurationError) {
      return { signupDomains: [], stored: {} };
    }

    throw error;
  }
}

export type SignInConfig = {
  passwordPolicy: PasswordSignInPolicy;
  sso: SsoConfig | null;
  workspaceDomains: WorkspaceDomains;
};

export function resolveSignInConfig(
  signIn: SignInSettings | null,
  env: EnvSource = process.env,
): SignInConfig {
  const stored = signIn?.stored ?? null;

  return {
    passwordPolicy: readPasswordSignInPolicy(env, stored),
    sso: readSsoConfig(env, stored),
    workspaceDomains: resolveWorkspaceDomains({
      env,
      signupDomains: signIn?.signupDomains ?? [],
      stored,
    }),
  };
}

/** For the sign-in and sign-up pages. */
export async function getSignInConfig(
  env: EnvSource = process.env,
): Promise<SignInConfig> {
  let signIn: SignInSettings | null = null;

  try {
    signIn = await loadSignInSettings(env);
  } catch (error) {
    // The pages still work on the environment's settings alone.
    console.error("[auth] Could not read the stored sign-in settings:", error);
  }

  return resolveSignInConfig(signIn, env);
}
