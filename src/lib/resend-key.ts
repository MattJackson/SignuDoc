import { Resend } from "resend";

import {
  saveIntegrationSettings,
  type IntegrationSettingsActor,
} from "./integration-settings.ts";
import { resolveResendApiKey } from "./services/email.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

// A Resend API key pasted into the app, for installs where nobody set
// RESEND_API_KEY (the Resend integration on Vercel sets it; elsewhere it
// had to be added by hand). It is checked with Resend before it is kept,
// stored encrypted (integration-settings.ts), and never shown again.
// RESEND_API_KEY, when it is set, wins.

export type ResendKeyAccess = "full" | "sending";

export type ResendKeyCheck =
  { access: ResendKeyAccess; ok: true } | { message: string; ok: false };

export type ResendKeyState = {
  /** Where the key in use comes from, or null when there is none. */
  source: "env" | "settings" | null;
};

type DomainsLister = Pick<Resend["domains"], "list">;

/** Resend's keys start with re_ and carry no spaces. */
export function looksLikeResendKey(value: string): boolean {
  return /^re_[A-Za-z0-9_-]{8,200}$/.test(value.trim());
}

/**
 * Asks Resend whether the key works. A key with full access can list the
 * account's domains, which is what lets the app add the sending domain and
 * show its DNS records. A key that may only send is refused that, with its
 * own error, and is still a working key.
 * https://resend.com/docs/api-reference/errors
 */
export async function checkResendApiKey(
  apiKey: string,
  domains: DomainsLister = new Resend(apiKey.trim()).domains,
): Promise<ResendKeyCheck> {
  if (!looksLikeResendKey(apiKey)) {
    return {
      message: "That is not a Resend API key. They start with re_.",
      ok: false,
    };
  }

  let result: Awaited<ReturnType<DomainsLister["list"]>>;

  try {
    result = await domains.list({ limit: 1 });
  } catch {
    return { message: "Resend could not be reached. Try again.", ok: false };
  }

  if (!result.error) {
    return { access: "full", ok: true };
  }

  const error = result.error as { name?: string; statusCode?: number | null };

  if (error.name === "restricted_api_key" && error.statusCode !== 403) {
    return { access: "sending", ok: true };
  }

  return {
    message:
      error.name === "invalid_api_key" || error.statusCode === 403
        ? "Resend did not accept this key. Check that it was copied whole and has not been deleted."
        : `Resend refused this key: ${result.error.message}`,
    ok: false,
  };
}

export async function getResendKeyState(
  env: EnvSource = process.env,
): Promise<ResendKeyState> {
  const resolved = await resolveResendApiKey(env);

  return { source: resolved?.source ?? null };
}

export class ResendKeyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ResendKeyError";
    this.statusCode = statusCode;
  }
}

/**
 * Checks and keeps a pasted key, or removes the stored one (null). Refused
 * while RESEND_API_KEY is set, since that one is used whatever is stored.
 */
export async function saveResendApiKey(
  apiKey: string | null,
  actor: IntegrationSettingsActor,
  {
    check = checkResendApiKey,
    env = process.env,
  }: {
    check?: (apiKey: string) => Promise<ResendKeyCheck>;
    env?: EnvSource;
  } = {},
): Promise<{ access: ResendKeyAccess | null }> {
  if (getEnv(env).email.apiKey) {
    throw new ResendKeyError(
      "RESEND_API_KEY is set where this site runs, and it is the key in use. Change it there.",
      409,
    );
  }

  if (apiKey === null) {
    await saveIntegrationSettings({ "resend.apiKey": null }, actor, {
      area: "email",
      env,
    });

    return { access: null };
  }

  const result = await check(apiKey);

  if (!result.ok) {
    throw new ResendKeyError(result.message, 400);
  }

  await saveIntegrationSettings({ "resend.apiKey": apiKey.trim() }, actor, {
    area: "email",
    env,
  });

  return { access: result.access };
}
