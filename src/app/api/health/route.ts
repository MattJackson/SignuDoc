import { NextResponse } from "next/server";

// For a platform's startup and liveness checks, such as Cloud Run's probes
// (deploy/google-cloud). It answers as soon as the server can take
// requests and does not touch the database: a database outage should not
// get every instance restarted, which would only add to the trouble.

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
