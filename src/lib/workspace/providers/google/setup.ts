import type { EnvSource } from "../../../utils/env.ts";
import {
  isDirectoryEnabled,
  readAdminGroup,
} from "../../directory-settings.ts";
import type { WorkspaceSettings } from "../../settings.ts";
import type {
  WorkspaceAddInSite,
  WorkspaceCheck,
  WorkspaceCheckContext,
  WorkspaceCheckTarget,
  WorkspaceIdentity,
  WorkspaceSetup,
  WorkspaceSetupSite,
} from "../../types.ts";
import { checkGoogleAddon, describeAddonDeployment } from "./addon/setup.ts";
import {
  GOOGLE_SCOPES,
  googleCredentialsFor,
  type GoogleCredentials,
  type GoogleCredentialsSource,
} from "./credentials.ts";
import {
  createGoogleDirectory,
  describeDirectoryStatus,
  needsCustomerId,
  readGoogleDirectoryConfig,
} from "./directory.ts";
import { createGoogleFiles } from "./drive/drive-files.ts";
import { createGoogleAutomaticSetup } from "./workspace-setup/automatic.ts";
import {
  buildGoogleGuide,
  normalizeGoogleGuideValue,
} from "./workspace-setup/guide.ts";

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
  /** The stored workspace settings (WorkspaceContext). */
  settings?: WorkspaceSettings;
};

export function createGoogleSetup({
  env = process.env,
  getCredentials,
  settings = {},
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

  /**
   * Reads the directory as the site would, whether or not it is turned on
   * yet, so access can be tried before people see suggestions.
   */
  async function checkDirectory(
    context: WorkspaceCheckContext,
  ): Promise<WorkspaceCheck> {
    const name = "Read the directory";

    try {
      const credentials = credentialsFor();

      if (!credentials) {
        return {
          id: "directory",
          message: describeGoogleIdentity(null),
          name,
          ok: false,
        };
      }

      const config = readGoogleDirectoryConfig(settings, env);
      const how =
        config.mode === "delegation"
          ? `with domain-wide delegation as ${config.adminSubject ?? ""}`
          : "with the service account's admin role";
      const term = context.email ?? "";
      const people = term
        ? await createGoogleDirectory({
            config,
            credentials,
            env,
          }).searchPeople(term, 3)
        : [];

      if (people.length === 0) {
        return {
          id: "directory",
          message: needsCustomerId(config)
            ? `The directory answered, but did not list ${term}. With the admin role, enter the Customer ID from Admin console, Account settings.`
            : `The directory answered, but did not list ${term}. Check that this account is in the Workspace and active.`,
          name,
          ok: false,
        };
      }

      return {
        id: "directory",
        message: `The directory can be read ${how}. Found: ${people
          .map((person) => `${person.name} <${person.email}>`)
          .join(
            ", ",
          )}.${isDirectoryEnabled(settings, env) ? "" : " It is not turned on yet."}`,
        name,
        ok: true,
      };
    } catch (error) {
      return { id: "directory", message: errorMessage(error), name, ok: false };
    }
  }

  /** Looks the administrator up in the administrator group. */
  async function checkAdminGroup(
    context: WorkspaceCheckContext,
  ): Promise<WorkspaceCheck> {
    const name = "The administrator group";

    try {
      const setting = readAdminGroup(settings, env);

      if (!setting.group) {
        return {
          id: "adminGroup",
          message: setting.problem ?? "No administrator group is set.",
          name,
          ok: false,
        };
      }

      const credentials = credentialsFor();

      if (!credentials) {
        return {
          id: "adminGroup",
          message: describeDirectoryStatus(null),
          name,
          ok: false,
        };
      }

      const email = context.email ?? "";
      const isMember = email
        ? await createGoogleDirectory({
            config: readGoogleDirectoryConfig(settings, env),
            credentials,
            env,
          }).isGroupMember(setting.group, email)
        : false;

      return {
        id: "adminGroup",
        message: isMember
          ? `You are in ${setting.group}, so you stay an administrator when you sign in with single sign-on.`
          : `You are not in ${setting.group}. When you next sign in with single sign-on you would stop being an administrator, unless you are the last one. Add yourself to the group first.`,
        name,
        ok: isMember,
      };
    } catch (error) {
      return {
        id: "adminGroup",
        message: errorMessage(error),
        name,
        ok: false,
      };
    }
  }

  async function check(
    target: WorkspaceCheckTarget,
    context: WorkspaceCheckContext = {},
  ): Promise<WorkspaceCheck[]> {
    switch (target) {
      case "identity":
        return [await checkIdentity()];
      case "directory":
        return [await checkDirectory(context)];
      case "adminGroup":
        return [await checkAdminGroup(context)];
      case "files":
        // The Picker, the Shared Drive and the label (drive/).
        return createGoogleFiles({
          credentials: credentialsFor,
          env,
          stored: settings,
        }).check();
      case "addIn":
        // The Gmail and Drive add-on (addon/).
        return checkGoogleAddon({ env, settings });
      default:
        return [];
    }
  }

  return {
    addInDeployment: (site: WorkspaceAddInSite) =>
      describeAddonDeployment({ env, settings, site }),
    // One sign-in as a Workspace super admin sets it all up
    // (workspace-setup/). Its last step runs these checks with what it saved.
    automatic: createGoogleAutomaticSetup({
      check: (target, saved, context) =>
        createGoogleSetup({ env, getCredentials, settings: saved }).check(
          target,
          context,
        ),
      env,
      getCredentials,
    }),
    check,
    guide: (site: WorkspaceSetupSite) =>
      buildGoogleGuide({ env, getCredentials, settings, site }),
    identity,
    normalizeGuideValue: normalizeGoogleGuideValue,
  };
}
