import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import { BrandLogoError, saveBrandLogo } from "@/lib/brand-logo";
import { buildBrandLogoPath } from "@/lib/branding";
import { getIntegrationSettings } from "@/lib/integration-settings";
import {
  fetchChosenLogo,
  findLogoSuggestions,
  logoDomains,
} from "@/lib/logo-suggestions";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordAdminActivity } from "@/lib/services/admin-activity";
import { getSettings } from "@/lib/settings";

// "Use the logo from your website": GET lists the logos the organization's
// own website points at, with previews; POST stores the one chosen.
// Administrators only, and never for the hosted service. The fetching rules
// are in lib/logo-fetch.ts.

export const maxDuration = 30;

const privateNoStore = { "cache-control": "private, no-store" };

async function authorize(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const settings = await getSettings();

  if (settings.hosted) {
    return NextResponse.json(
      { error: "This site does not use its own logo." },
      { headers: privateNoStore, status: 409 },
    );
  }

  const limited = await applyRateLimit({
    category: "brand_logo_suggestions",
    key: buildRateLimitKey(["brand-logo-suggestions", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const domains = logoDomains({
    adminEmail: session.user.email,
    env: process.env,
    settings,
    stored: await getIntegrationSettings(),
  });

  return { domains, session };
}

export async function GET(request: Request) {
  const authorized = await authorize(request);

  if (authorized instanceof Response) {
    return authorized;
  }

  const { domains, session } = authorized;
  const asked = new URL(request.url).searchParams.get("domain")?.toLowerCase();
  const domain = asked && domains.includes(asked) ? asked : domains[0];

  if (!domain) {
    return NextResponse.json(
      {
        domains,
        error:
          "This site does not know your organization's domain yet. Upload the logo instead.",
      },
      { headers: privateNoStore, status: 404 },
    );
  }

  try {
    return NextResponse.json(
      { domains, ...(await findLogoSuggestions(domain, domains)) },
      { headers: privateNoStore },
    );
  } catch (error) {
    logRouteError(error, {
      category: "brand_logo_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while looking for the website's logo.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The website's logo could not be looked up." },
      { headers: privateNoStore, status: 500 },
    );
  }
}

const chooseSchema = z.object({ url: z.string().trim().min(1).max(2048) });

export async function POST(request: Request) {
  const authorized = await authorize(request);

  if (authorized instanceof Response) {
    return authorized;
  }

  const { domains, session } = authorized;
  const parsed = chooseSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose one of the logos shown." },
      { headers: privateNoStore, status: 400 },
    );
  }

  try {
    const logo = await fetchChosenLogo(parsed.data.url, domains);

    if (!logo.ok) {
      return NextResponse.json(
        { error: logo.reason },
        { headers: privateNoStore, status: 422 },
      );
    }

    const version = await saveBrandLogo(logo.bytes);

    await recordAdminActivity({
      event: "logo_changed",
      metadata: { action: "fetched", source: parsed.data.url, version },
      request,
      user: session.user,
    });

    return NextResponse.json(
      { logoUrl: buildBrandLogoPath(version) },
      { headers: privateNoStore },
    );
  } catch (error) {
    if (error instanceof BrandLogoError) {
      return NextResponse.json(
        { error: error.message },
        { headers: privateNoStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "brand_logo_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while saving the website's logo.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The logo could not be saved." },
      { headers: privateNoStore, status: 500 },
    );
  }
}
