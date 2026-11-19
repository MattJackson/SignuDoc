import { getBranding } from "../settings.ts";
import type { EnvSource } from "../utils/env.ts";
import { addInSiteUrl } from "./add-in-support.ts";
import {
  getWorkspaceAddIn,
  getWorkspaceContext,
  resolveCapabilityProvider,
} from "./registry.ts";
import type {
  WorkspaceAddIn,
  WorkspaceAddInDeployment,
  WorkspaceCheck,
} from "./types.ts";

// The app's side of a workspace add-in (types.ts, WorkspaceAddIn): the one
// route the provider calls, /api/workspace/add-in/<action>, and what
// Settings shows an administrator to deploy it. The provider verifies each
// request and answers in its own format; with no provider serving the
// add-in, the route answers 404, as if it were not there.

const NO_STORE = { "cache-control": "private, no-store" } as const;

// Actions are short lower-case names ("gmail-message"); anything else is
// not one, whatever the provider.
const ACTION_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { headers: NO_STORE, status });
}

export type AddInRequestOptions = {
  /** The configured add-in; the registry's by default. */
  getAddIn?: () => Promise<WorkspaceAddIn | null>;
  /** For a failure that is not the caller's; never shown to them. */
  logError?: (error: unknown) => void;
};

/** Answers one request to the add-in route. */
export async function handleAddInRequest(
  action: string,
  request: Request,
  {
    getAddIn = () => getWorkspaceAddIn(),
    logError = (error) => {
      console.error(error);
    },
  }: AddInRequestOptions = {},
): Promise<Response> {
  if (!ACTION_PATTERN.test(action)) {
    return json({ error: "Not found." }, 404);
  }

  try {
    const addIn = await getAddIn();

    if (!addIn) {
      return json({ error: "Not found." }, 404);
    }

    return await addIn.handle(action, request);
  } catch (error) {
    logError(error);
    return json({ error: "Something went wrong." }, 500);
  }
}

export type AddInSettingsView = {
  deployment: WorkspaceAddInDeployment | null;
  /** The provider serving the add-in, for headings: "Google Workspace". */
  provider: string;
};

/**
 * What Settings shows to deploy the add-in, or null when no provider is
 * chosen for it.
 */
export async function getAddInSettingsView(
  env: EnvSource = process.env,
): Promise<AddInSettingsView | null> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "addIn",
    context.settings,
    env,
  );

  if (!provider) {
    return null;
  }

  const branding = await getBranding(env);
  const setup = provider.setup(context);

  return {
    deployment:
      setup.addInDeployment?.({
        brandColor: branding.brandColor,
        name: branding.organizationName,
        url: addInSiteUrl(env),
      }) ?? null,
    provider: provider.label,
  };
}

/** The add-in's checks, from its provider; [] when none is chosen. */
export async function checkAddIn(
  env: EnvSource = process.env,
): Promise<WorkspaceCheck[]> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "addIn",
    context.settings,
    env,
  );

  return provider ? provider.setup(context).check("addIn") : [];
}
