import { MAX_LOGO_BYTES, sniffLogoContentType } from "./brand-logo.ts";
import { resolveWorkspaceDomains } from "./auth/sso.ts";
import type { IntegrationSettings } from "./integration-settings.ts";
import {
  extractPngFromIco,
  findLogoCandidates,
  pngDimensions,
  rankLogoCandidates,
  type LogoCandidate,
  type LogoSource,
} from "./logo-candidates.ts";
import { fetchFromOwnDomain, LogoFetchError } from "./logo-fetch.ts";
import type { ResolvedSettings } from "./settings.ts";
import { getEmailDomain, isPublicMailboxDomain } from "./signup-policy.ts";
import type { EnvSource } from "./utils/env.ts";

// "Use the logo from your website" in onboarding and Settings: the logos an
// organization's own site points at, fetched safely (logo-fetch.ts), shown
// as previews, and the one an administrator picks stored as the install's
// logo.

/**
 * The domains whose websites may be asked for a logo: the administrator's
 * own email domain, the Google Workspace domains and the sign-up domains.
 * Public mailbox providers are never among them.
 */
export function logoDomains(input: {
  adminEmail: string;
  env: EnvSource;
  settings: ResolvedSettings;
  stored: IntegrationSettings;
}): string[] {
  const signupDomains =
    input.settings.signupMode === "domains"
      ? input.settings.allowedEmailDomains
      : [];
  const domains = [
    getEmailDomain(input.adminEmail),
    ...resolveWorkspaceDomains({
      env: input.env,
      signupDomains,
      stored: input.stored,
    }).domains,
    ...signupDomains,
  ]
    .filter((domain): domain is string => Boolean(domain))
    .map((domain) => domain.toLowerCase())
    .filter((domain) => !isPublicMailboxDomain(domain));

  return Array.from(new Set(domains));
}

export type PreparedLogo =
  | {
      bytes: Uint8Array;
      contentType: "image/jpeg" | "image/png" | "image/webp";
      ok: true;
    }
  | { ok: false; reason: string };

/** What can be stored of a fetched image, or why it cannot be. */
export function prepareLogo(
  contentType: string,
  bytes: Uint8Array,
): PreparedLogo {
  if (contentType === "image/svg+xml") {
    return {
      ok: false,
      reason:
        "An SVG cannot be used as the logo (emails do not show it). Save it as a PNG and upload that.",
    };
  }

  const image =
    contentType === "image/x-icon" || contentType === "image/vnd.microsoft.icon"
      ? extractPngFromIco(bytes)
      : bytes;

  if (!image) {
    return {
      ok: false,
      reason: "This icon is in an old format. Upload a PNG instead.",
    };
  }

  const sniffed = sniffLogoContentType(image);

  if (!sniffed) {
    return { ok: false, reason: "This is not a PNG, JPEG or WebP image." };
  }

  if (image.length > MAX_LOGO_BYTES) {
    return {
      ok: false,
      reason: `This image is larger than ${String(MAX_LOGO_BYTES / 1024)} KB.`,
    };
  }

  return { bytes: image, contentType: sniffed, ok: true };
}

export type LogoSuggestion = {
  /** Width x height when known, such as "180 x 180". */
  dimensions: string | null;
  /** A data: URL to show it, or null when it could not be fetched. */
  preview: string | null;
  /** Why it cannot be used, when it cannot. */
  problem: string | null;
  source: LogoSource;
  url: string;
};

export type LogoSuggestions = {
  domain: string;
  /** Why the site's page could not be read, when it could not. */
  pageProblem: string | null;
  suggestions: LogoSuggestion[];
};

function dataUrl(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function describe(
  candidate: LogoCandidate,
  domains: readonly string[],
  fetchImpl: typeof fetchFromOwnDomain,
): Promise<LogoSuggestion | null> {
  try {
    const fetched = await fetchImpl(candidate.url, { domains, kind: "image" });
    const prepared = prepareLogo(fetched.contentType, fetched.bytes);
    const shown = prepared.ok ? prepared.bytes : fetched.bytes;
    const size = pngDimensions(shown);

    return {
      dimensions: size
        ? `${String(size.width)} x ${String(size.height)}`
        : null,
      // Only small images are sent back for the preview. An SVG shown in
      // an <img> cannot run scripts.
      preview:
        shown.length <= MAX_LOGO_BYTES
          ? dataUrl(
              prepared.ok ? prepared.contentType : fetched.contentType,
              shown,
            )
          : null,
      problem: prepared.ok ? null : prepared.reason,
      source: candidate.source,
      url: candidate.url,
    };
  } catch (error) {
    // The fallback /favicon.ico is a guess; when it is not there, it is
    // left out rather than shown as broken.
    if (candidate.source === "favicon") {
      return null;
    }

    return {
      dimensions: null,
      preview: null,
      problem:
        error instanceof LogoFetchError
          ? error.message
          : "It could not be fetched.",
      source: candidate.source,
      url: candidate.url,
    };
  }
}

/** The logos https://<domain>/ points at, best first, with previews. */
export async function findLogoSuggestions(
  domain: string,
  domains: readonly string[],
  fetchImpl: typeof fetchFromOwnDomain = fetchFromOwnDomain,
): Promise<LogoSuggestions> {
  const home = `https://${domain}/`;
  let candidates: LogoCandidate[];
  let pageProblem: string | null = null;

  try {
    const page = await fetchImpl(home, { domains, kind: "html" });

    candidates = findLogoCandidates(
      new TextDecoder("utf-8", { fatal: false }).decode(page.bytes),
      page.url,
    );
  } catch (error) {
    pageProblem =
      error instanceof LogoFetchError
        ? error.message
        : "The website could not be read.";
    candidates = findLogoCandidates("", home);
  }

  const described = await Promise.all(
    rankLogoCandidates(candidates).map((candidate) =>
      describe(candidate, domains, fetchImpl),
    ),
  );
  const suggestions = described.filter(
    (item): item is LogoSuggestion => item !== null,
  );

  // Usable ones first; the sort is stable, so the ranking above decides
  // within each.
  suggestions.sort(
    (a, b) => Number(a.problem !== null) - Number(b.problem !== null),
  );

  return { domain, pageProblem, suggestions };
}

/** Fetches the chosen logo again and returns what can be stored. */
export async function fetchChosenLogo(
  url: string,
  domains: readonly string[],
  fetchImpl: typeof fetchFromOwnDomain = fetchFromOwnDomain,
): Promise<PreparedLogo> {
  try {
    const fetched = await fetchImpl(url, { domains, kind: "image" });

    return prepareLogo(fetched.contentType, fetched.bytes);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof LogoFetchError
          ? error.message
          : "The image could not be fetched.",
    };
  }
}
