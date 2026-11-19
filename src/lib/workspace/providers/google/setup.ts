import type { EnvSource } from "../../../utils/env.ts";
import type {
  WorkspaceCheck,
  WorkspaceCheckTarget,
  WorkspaceIdentity,
  WorkspaceSetup,
} from "../../types.ts";
import {
  GOOGLE_SCOPES,
  googleCredentialsFor,
  type GoogleCredentials,
  type GoogleCredentialsSource,
} from "./credentials.ts";

// The site's Google identity and the checks Settings runs for Google
// (WorkspaceSetup in ../../types.ts). The site acts as a Google service
// account (credentials.ts).

/** Which Google identity the site uses, in one sentence for the pages. */
export function describeGoogleIdentity(
  identity: { email: string; source: GoogleCredentialsSource } | null,
): string {
  if (!identity) {
    return "This site has no Google identity. Run it on Google Cloud (Cloud Run, GKE, Compute Engine) as a service account, or set GOOGLE_SERVICE_ACCOUNT_KEY, or GOOGLE_IMPERSONATE_SERVICE_ACCOUNT with a gcloud login mounted.";
  }

  switch (identity.source) {
    case "metadata":
      return `Runs on Google Cloud as ${identity.email}, with no key stored.`;
    case "service-account-key":
      return `Uses the key in GOOGLE_SERVICE_ACCOUNT_KEY for ${identity.email}.`;
    case "impersonation":
      return `Impersonates ${identity.email} with the mounted gcloud login.`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

type GoogleSetupOptions = {
  env?: EnvSource;
  /** For tests; the shared credentials otherwise. */
  getCredentials?: () => GoogleCredentials | null;
};

export function createGoogleSetup({
  env = process.env,
  getCredentials,
}: GoogleSetupOptions = {}): WorkspaceSetup {
  const credentialsFor = getCredentials ?? (() => googleCredentialsFor(env));

  async function identity(): Promise<WorkspaceIdentity> {
    let credentials: GoogleCredentials | null;

    try {
      credentials = credentialsFor();
    } catch (error) {
      // A key that does not parse, or impersonation with no login.
      return {
        account: null,
        configured: false,
        description: errorMessage(error),
      };
    }

    if (!credentials) {
      return {
        account: null,
        configured: false,
        description: describeGoogleIdentity(null),
      };
    }

    try {
      const email = await credentials.getServiceAccountEmail();

      return {
        account: email,
        configured: true,
        description: describeGoogleIdentity({
          email,
          source: credentials.source,
        }),
      };
    } catch (error) {
      return {
        account: null,
        configured: false,
        description: errorMessage(error),
      };
    }
  }

  /** Gets a token as the site, which proves the identity works. */
  async function checkIdentity(): Promise<WorkspaceCheck> {
    const name = "The site's Google identity";

    try {
      const credentials = credentialsFor();

      if (!credentials) {
        return {
          id: "identity",
          message: describeGoogleIdentity(null),
          name,
          ok: false,
        };
      }

      await credentials.getAccessToken({
        scopes: [GOOGLE_SCOPES.cloudPlatform],
      });

      return {
        id: "identity",
        message: describeGoogleIdentity({
          email: await credentials.getServiceAccountEmail(),
          source: credentials.source,
        }),
        name,
        ok: true,
      };
    } catch (error) {
      return { id: "identity", message: errorMessage(error), name, ok: false };
    }
  }

  return {
    async check(target: WorkspaceCheckTarget): Promise<WorkspaceCheck[]> {
      switch (target) {
        case "identity":
          return [await checkIdentity()];
        default:
          return [];
      }
    },
    identity,
  };
}
