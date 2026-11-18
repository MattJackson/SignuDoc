import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getIntegrationSettings } from "@/lib/integration-settings";
import {
  getDirectoryClient,
  MAX_DIRECTORY_RESULTS,
} from "@/lib/integrations/google/directory";
import { logSecurityEvent } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getRequestPathname } from "@/lib/security/request";

// People in the organization's Google Workspace directory whose name or
// address starts with what a sender is typing, to suggest as signers and
// copy recipients. Any signed-in sender may ask, as anyone in a Workspace
// can look colleagues up in Gmail. Only name and address are returned.
// With the directory off, the answer says so and the page stops asking.

const MIN_TERM_LENGTH = 2;

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const term = (new URL(request.url).searchParams.get("q") ?? "").trim();
  let directory;

  try {
    directory = getDirectoryClient(process.env, await getIntegrationSettings());
  } catch {
    directory = null;
  }

  if (!directory) {
    return NextResponse.json({ enabled: false, people: [] });
  }

  if (term.length < MIN_TERM_LENGTH) {
    return NextResponse.json({ enabled: true, people: [] });
  }

  // Typing sends a request every few keystrokes; this allows a busy sender
  // plenty while keeping a script from reading out the whole directory.
  const limited = await applyRateLimit({
    category: "directory_search",
    key: buildRateLimitKey(["directory-search", session.user.id]),
    limit: 120,
    request,
    userId: session.user.id,
    windowMs: 5 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const people = await directory.searchUsers(term, MAX_DIRECTORY_RESULTS);

    return NextResponse.json(
      { enabled: true, people },
      { headers: { "cache-control": "private, max-age=60" } },
    );
  } catch (error) {
    logSecurityEvent("warn", {
      category: "directory_search_failed",
      message: "The Workspace directory could not be searched.",
      metadata: { error: error instanceof Error ? error.message : "unknown" },
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    // Suggestions are a help, not a step: the sender types the address.
    return NextResponse.json({ enabled: true, people: [] });
  }
}
