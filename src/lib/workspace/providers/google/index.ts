import type { WorkspaceProviderPackage } from "../../types.ts";
import { createGoogleAddIn } from "./addon/add-on.ts";
import { googleDirectoryFor } from "./directory.ts";
import { createGoogleFiles, isGoogleFilesSetUp } from "./drive/drive-files.ts";
import { createGoogleSetup } from "./setup.ts";

// Google Workspace as a workspace provider. Everything Google is in this
// folder: the site's credentials (credentials.ts), where Google is reached
// (endpoints.ts), each capability, and a fake Google server for the tests
// (test-support). The rest of the app sees only this package, through the
// registry (../../registry.ts).
//
// The capabilities are added as they land; one that is absent here is not
// offered by this provider.

export const googleWorkspace: WorkspaceProviderPackage = {
  // The Gmail and Drive add-on (addon/).
  addIn: ({ env, settings }) => createGoogleAddIn({ env, settings }),
  // The Admin SDK directory, read-only (directory.ts).
  directory: (context) => googleDirectoryFor(context),
  // Google Drive: start envelopes from Drive, and executed copies in a
  // Shared Drive (drive/).
  files: ({ env, settings }) =>
    isGoogleFilesSetUp(settings, env)
      ? createGoogleFiles({ env, stored: settings })
      : null,
  id: "google",
  label: "Google Workspace",
  setup: ({ env, settings }) => createGoogleSetup({ env, settings }),
};
