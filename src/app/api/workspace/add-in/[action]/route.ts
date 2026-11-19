import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { handleAddInRequest } from "@/lib/workspace/add-in";

// The workspace add-in's endpoints (a Google Workspace add-on in Gmail and
// Drive, or another provider's add-in), one per action. The provider that
// serves the add-in verifies that each request came from it before reading
// anything (lib/workspace/add-in.ts). With no add-in set up, every action
// answers 404, as if it were not there.

// Converting a document and storing it can take a while.
export const maxDuration = 60;

type AddInRouteContext = { params: Promise<{ action: string }> };

export async function POST(request: Request, context: AddInRouteContext) {
  const { action } = await context.params;

  return handleAddInRequest(action, request, {
    logError: (error) => {
      logRouteError(error, {
        category: "workspace_add_in_failure",
        ipAddress: getClientIpAddress(request.headers),
        message: "Unexpected failure in the workspace add-in.",
        path: getRequestPathname(request),
      });
    },
  });
}
