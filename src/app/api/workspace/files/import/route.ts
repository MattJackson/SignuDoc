import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { buildCreateEnvelopeResponse } from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  describeImportFailure,
  getImportableFiles,
  importFileAsDraft,
} from "@/lib/workspace/files";
import { NO_STORE } from "@/lib/workspace/files-routes";

// A draft from a file the person picked in the provider's picker, made
// into a PDF by the provider and then stored like an upload.

// Converting a big file can take a while.
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  // The same allowance as creating a draft by upload.
  const limited = await applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => null)) as {
    fileId?: unknown;
  } | null;
  const fileId = body?.fileId;

  if (
    typeof fileId !== "string" ||
    fileId.length === 0 ||
    fileId.length > 200
  ) {
    return NextResponse.json(
      { error: "Choose a file to start from." },
      { status: 400 },
    );
  }

  const files = await getImportableFiles();

  if (!files) {
    return NextResponse.json(
      { error: "Starting from a file is not set up on this site." },
      { status: 409 },
    );
  }

  try {
    const result = await importFileAsDraft(
      files,
      { fileId, userId: session.user.id },
      { database: getDb() },
    );

    return NextResponse.json(buildCreateEnvelopeResponse(result), {
      headers: NO_STORE,
      status: 201,
    });
  } catch (error) {
    const known = describeImportFailure(error);

    if (known) {
      return NextResponse.json(
        { connect: known.connect, error: known.message },
        { headers: NO_STORE, status: known.status },
      );
    }

    logRouteError(error, {
      category: "draft_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating a draft from a file.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to create the draft envelope." },
      { status: 500 },
    );
  }
}
