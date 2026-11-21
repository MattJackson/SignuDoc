import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { getSealCertificateDownload } from "@/lib/seal-setup";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";

// The certificate the install seals with, for an administrator to hand out
// to company computers so PDF readers trust the seal: ?format=pem (text)
// or ?format=cer (DER, what Windows and most MDM tools expect). Only the
// certificate; the key never leaves the server.

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const format = new URL(request.url).searchParams.get("format");

  if (format !== "pem" && format !== "cer") {
    return NextResponse.json(
      { error: "Ask for format=pem or format=cer." },
      { status: 400 },
    );
  }

  try {
    const download = await getSealCertificateDownload(format);

    return new Response(download.body.slice().buffer as ArrayBuffer, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(download.fileName),
        "content-length": String(download.body.byteLength),
        "content-type": download.contentType,
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    logRouteError(error, {
      category: "seal_certificate_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The seal certificate could not be downloaded.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
