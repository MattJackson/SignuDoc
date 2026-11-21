"use client";

/* eslint-disable @next/next/no-img-element -- previews are data: URLs from the server */
import { useState } from "react";

import type { LogoSuggestion } from "@/lib/logo-suggestions";

// "Use the logo from your website": asks the server for the logos the
// organization's own site points at (api/admin/logo/suggestions) and stores
// the one chosen. Nothing is fetched until the button is pressed.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const SOURCE_LABELS: Record<LogoSuggestion["source"], string> = {
  "apple-touch-icon": "App icon",
  favicon: "Browser icon (favicon.ico)",
  icon: "Site icon",
  "og:image": "Sharing image",
};

type SuggestionsResponse = {
  domain?: string;
  domains?: string[];
  error?: string;
  pageProblem?: string | null;
  suggestions?: LogoSuggestion[];
} | null;

export function LogoSuggestions({
  disabled,
  onLogoChange,
}: {
  disabled: boolean;
  onLogoChange: (logoUrl: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    domain: string;
    domains: string[];
    pageProblem: string | null;
    suggestions: LogoSuggestion[];
  } | null>(null);

  async function look(domain?: string) {
    setBusy("look");
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/logo/suggestions${domain ? `?domain=${encodeURIComponent(domain)}` : ""}`,
      );
      const payload = (await response
        .json()
        .catch(() => null)) as SuggestionsResponse;

      if (!response.ok || !payload?.suggestions || !payload.domain) {
        setResult(null);
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setResult({
        domain: payload.domain,
        domains: payload.domains ?? [payload.domain],
        pageProblem: payload.pageProblem ?? null,
        suggestions: payload.suggestions,
      });
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  async function choose(url: string) {
    setBusy(url);
    setError(null);

    try {
      const response = await fetch("/api/admin/logo/suggestions", {
        body: JSON.stringify({ url }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        logoUrl?: string;
      } | null;

      if (!response.ok || !payload?.logoUrl) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      onLogoChange(payload.logoUrl);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  const locked = disabled || busy !== null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-quiet"
          disabled={locked}
          onClick={() => void look(result?.domain)}
          type="button"
        >
          {busy === "look"
            ? "Looking..."
            : result
              ? "Look again"
              : "Use the logo from your website"}
        </button>
        {result && result.domains.length > 1 ? (
          <label className="flex items-center gap-2 text-xs font-semibold text-(--secondary)">
            Website
            <select
              className="field-input h-9 w-auto py-1"
              disabled={locked}
              onChange={(event) => void look(event.target.value)}
              value={result.domain}
            >
              {result.domains.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs font-semibold text-(--danger)" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-2" aria-live="polite">
          {result.pageProblem ? (
            <p className="text-xs leading-5 text-(--tertiary)">
              https://{result.domain}/ could not be read: {result.pageProblem}
            </p>
          ) : null}
          {result.suggestions.length === 0 ? (
            <p className="text-xs leading-5 text-(--tertiary)">
              No logo was found on https://{result.domain}/. Upload one instead.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {result.suggestions.map((suggestion) => (
                <li
                  className="flex items-center gap-3 rounded-xl bg-(--paper) p-3"
                  key={suggestion.url}
                >
                  <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-(--surface)">
                    {suggestion.preview ? (
                      <img
                        alt=""
                        className="max-h-14 max-w-14 object-contain"
                        src={suggestion.preview}
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block text-xs font-bold text-(--fg)">
                      {SOURCE_LABELS[suggestion.source]}
                      {suggestion.dimensions
                        ? `, ${suggestion.dimensions}`
                        : ""}
                    </span>
                    {suggestion.problem ? (
                      <span className="block text-xs leading-5 text-(--tertiary)">
                        {suggestion.problem}
                      </span>
                    ) : (
                      <button
                        className="btn-quiet"
                        disabled={locked}
                        onClick={() => void choose(suggestion.url)}
                        type="button"
                      >
                        {busy === suggestion.url ? "Saving..." : "Use this"}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
