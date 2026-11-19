// For a container or load balancer's startup and liveness checks, such as
// the Docker image's HEALTHCHECK. It answers as soon as the server can take
// requests and does not touch the database: a database outage should not
// get every instance restarted, which would only add to the trouble.

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
