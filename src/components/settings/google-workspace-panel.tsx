"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { describeSsoError } from "@/components/auth/sso-button";
import { useBranding } from "@/components/layout/branding-provider";
import {
  ActionRow,
  AutomaticGoogleSetupNotice,
  CheckItem,
  CopyValue,
  EnvLockedNotice,
  ExternalLink,
  IntegrationPanel,
  Notice,
  SetupSteps,
  TestResult,
  type ConnectionStatus,
} from "@/components/settings/integration-kit";
import { saveFailureMessage } from "@/components/settings/google-save-notice";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import {
  apiLibraryUrl,
  consoleUrl,
  googleProjectId,
  originOf,
} from "@/lib/google-console";
import type {
  DirectoryTestResult,
  GoogleWorkspaceView,
  GroupTestResult,
} from "@/lib/google-workspace";
import {
  directoryRoleName,
  DRIVE_CALLBACK_PATH,
  SETUP_CALLBACK_PATH,
  SSO_CALLBACK_PATH,
} from "@/lib/integrations/google/workspace-setup-names";

// Settings, Integrations, Google sign-in and Workspace directory, and the
// onboarding steps of the same names. Each is a numbered checklist: what to
// do in Google's consoles, with this site's own values to copy there, and
// live checks of what is already in place. Values fixed by an environment
// variable are shown and locked. Google Drive (google-drive-panel.tsx) uses
// the same service account.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const ADMIN_ACCOUNT_SETTINGS_URL =
  "https://admin.google.com/ac/accountsettings/profile";
const ADMIN_ROLES_URL = "https://admin.google.com/ac/roles";
const ADMIN_DELEGATION_URL =
  "https://admin.google.com/ac/owl/domainwidedelegation";
const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
];

type SaveResult = {
  error?: string;
  fieldErrors: Record<string, string>;
  ok: boolean;
};

type SaveFields = Partial<{
  adminGroup: string;
  adminSubject: string;
  clientId: string;
  clientSecret: string;
  customerId: string;
  directoryEnabled: boolean;
  issuer: string;
  name: string;
  passwordAllowedEmails: string;
  passwordSignIn: boolean;
  removeClientSecret: boolean;
  workspaceDomains: string;
}>;

export function useGoogleWorkspace(initialView: GoogleWorkspaceView) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [error, setError] = useState<string | null>(null);

  async function save(fields: SaveFields): Promise<SaveResult> {
    setError(null);

    try {
      const response = await fetch("/api/admin/google", {
        body: JSON.stringify(fields),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        view?: GoogleWorkspaceView;
      } | null;

      if (!response.ok || !payload?.view) {
        const message = payload?.error ?? GENERIC_ERROR_MESSAGE;

        setError(message);
        return {
          error: message,
          fieldErrors: payload?.fieldErrors ?? {},
          ok: false,
        };
      }

      setView(payload.view);
      // The status in the page's header is worked out on the server.
      router.refresh();

      return { fieldErrors: {}, ok: true };
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
      return { error: GENERIC_ERROR_MESSAGE, fieldErrors: {}, ok: false };
    }
  }

  return { error, save, view };
}

type Workspace = ReturnType<typeof useGoogleWorkspace>;

type PanelProps = {
  detail: string;
  initialView: GoogleWorkspaceView;
  status: ConnectionStatus;
  /** How "Test sign-in" ended, from the address it came back to. */
  testOutcome?: { error?: string; ok: boolean } | null;
};

/** Settings, Integrations, Google sign-in. */
export function GoogleSignInPanel({
  detail,
  initialView,
  status,
  testOutcome = null,
}: PanelProps) {
  const workspace = useGoogleWorkspace(initialView);

  return (
    <IntegrationPanel
      brand="google"
      description="Everyone in your Google Workspace signs in with their Google account. Google's own security, such as two-step verification and suspending leavers, then applies here."
      detail={detail}
      id="google-sign-in"
      name="Google sign-in"
      status={status}
    >
      <TestResult
        result={
          testOutcome
            ? {
                message: testOutcome.ok
                  ? "Google sign-in works. You signed in with Google and came back here."
                  : describeSsoError(testOutcome.error ?? ""),
                ok: testOutcome.ok,
              }
            : null
        }
      />
      <AutomaticGoogleSetupNotice />
      <GoogleSignInSection workspace={workspace} />
    </IntegrationPanel>
  );
}

/** Settings, Integrations, Workspace directory. */
export function GoogleDirectoryPanel({
  detail,
  initialView,
  status,
}: PanelProps) {
  const workspace = useGoogleWorkspace(initialView);

  return (
    <IntegrationPanel
      brand="google"
      description="Suggest colleagues as recipients while a document is prepared, and make the members of a Google Group administrators here."
      detail={detail}
      id="google-directory"
      name="Workspace directory"
      status={status}
    >
      <AutomaticGoogleSetupNotice />
      <GoogleDirectorySection workspace={workspace} />
    </IntegrationPanel>
  );
}

function Feedback({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "success";
}) {
  return <Notice tone={tone}>{message}</Notice>;
}

function fromEnvHelper(name: string) {
  return `Set by the ${name} environment variable.`;
}

/**
 * Starts Google sign-in in a new tab and comes back to this page, which
 * says whether it worked. The tab is opened before asking for Google's
 * address, so a pop-up blocker lets it through.
 */
async function startTestSignIn(): Promise<string | null> {
  const tab = window.open("", "_blank");
  const origin = window.location.origin;
  const back = `${origin}/settings/integrations/google-sign-in`;

  try {
    const response = await fetch("/api/auth/sign-in/social", {
      body: JSON.stringify({
        callbackURL: `${back}?signin=ok`,
        errorCallbackURL: back,
        newUserCallbackURL: `${back}?signin=ok`,
        provider: "sso",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as {
      url?: string;
    } | null;

    if (!response.ok || !payload?.url) {
      tab?.close();
      return "Sign-in could not start. Save the client ID and secret first, then try again.";
    }

    if (tab) {
      tab.location.href = payload.url;
    } else {
      window.location.assign(payload.url);
    }

    return null;
  } catch {
    tab?.close();
    return GENERIC_ERROR_MESSAGE;
  }
}

/** Google sign-in: the OAuth client, the sign-up rule, and passwords. */
export function GoogleSignInSection({ workspace }: { workspace: Workspace }) {
  const { error, save, view } = workspace;
  const { productName } = useBranding();
  const { signIn } = view;
  const locked = signIn.source === "env";
  const passwordLocked = signIn.passwordSource === "env";
  const project = googleProjectId(view.serviceAccount.email);
  const siteOrigin = originOf(view.siteUrl);
  const [values, setValues] = useState({
    clientId: signIn.clientId,
    clientSecret: "",
    issuer: signIn.issuer,
    name: signIn.name,
    passwordAllowedEmails: signIn.passwordAllowedEmails.join(", "),
    workspaceDomains:
      signIn.workspaceDomains.source === "settings"
        ? signIn.workspaceDomains.domains.join(", ")
        : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [showOtherProvider, setShowOtherProvider] = useState(!signIn.google);
  const signupLimited =
    view.signupRule.mode === "domains" && view.signupRule.domains.length > 0;

  function change(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: "" }));
      setNotice(null);
    };
  }

  async function run(action: string, fields: SaveFields, done: string) {
    setPending(action);
    setNotice(null);

    const result = await save(fields);

    setErrors(result.fieldErrors);
    setPending(null);

    if (result.ok) {
      setNotice(done);
      setValues((current) => ({ ...current, clientSecret: "" }));
    }
  }

  function saveClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      "client",
      {
        clientId: values.clientId,
        ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
        issuer: showOtherProvider
          ? values.issuer
          : "https://accounts.google.com",
        name: values.name,
        workspaceDomains: values.workspaceDomains,
      },
      "Saved. Sign-in uses the new settings within a minute, with no restart or redeploy.",
    );
  }

  async function testSignIn() {
    setPending("test");
    setTestError(null);
    setTestError(await startTestSignIn());
    setPending(null);
  }

  return (
    <div className="space-y-5">
      {error ? <Feedback message={error} tone="error" /> : null}
      {notice ? <Feedback message={notice} tone="success" /> : null}

      <SetupSteps>
        <CheckItem ok={signIn.ready} title="1. Create the OAuth client">
          {project ? (
            <p>
              The links open project <strong>{project}</strong>, where this site
              runs.
            </p>
          ) : null}
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              No consent screen yet?{" "}
              <ExternalLink href={consoleUrl("/auth/overview", project)}>
                Open Google Auth Platform
              </ExternalLink>
              , choose <strong>Get started</strong>, paste the app name below,
              add your support and contact addresses, and choose{" "}
              <strong>Internal</strong> as the audience.
            </li>
            <li>
              <ExternalLink href={consoleUrl("/auth/clients/create", project)}>
                Create the OAuth client
              </ExternalLink>
              : choose <strong>Web application</strong> and paste the name
              below.
            </li>
            <li>
              Paste the JavaScript origin under{" "}
              <strong>Authorized JavaScript origins</strong> and the redirect
              URI under <strong>Authorized redirect URIs</strong>, then choose
              Create.
            </li>
            <li>Copy the client ID and secret into step 2.</li>
          </ol>
          <div className="grid gap-4">
            <CopyValue
              hint="Use it for the app name and for the client name."
              label="App name"
              value={productName}
            />
            {siteOrigin ? (
              <CopyValue
                hint="Under Authorized JavaScript origins."
                label="JavaScript origin"
                value={siteOrigin}
              />
            ) : null}
            {view.redirectUri ? (
              <CopyValue
                hint="Under Authorized redirect URIs."
                label="Redirect URI"
                value={view.redirectUri}
              />
            ) : null}
            {view.siteUrl ? (
              <>
                <CopyValue
                  hint="Also under Authorized redirect URIs, for connecting Google Drive."
                  label="Drive redirect URI"
                  value={`${view.siteUrl}${DRIVE_CALLBACK_PATH}`}
                />
                <CopyValue
                  hint="Also under Authorized redirect URIs, for the automatic setup."
                  label="Setup redirect URI"
                  value={`${view.siteUrl}${SETUP_CALLBACK_PATH}`}
                />
              </>
            ) : null}
            {view.redirectUri ? null : (
              <Notice tone="warning">
                This site does not know its own address yet. Set APP_URL (or
                BETTER_AUTH_URL) where it runs; the redirect URI is that address
                followed by {SSO_CALLBACK_PATH}.
              </Notice>
            )}
          </div>
        </CheckItem>

        <CheckItem ok={signIn.ready} title="2. Paste the client ID and secret">
          {locked ? (
            <EnvLockedNotice
              variables={["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET"]}
            >
              <p>
                Issuer: <code>{signIn.issuer}</code>
              </p>
            </EnvLockedNotice>
          ) : (
            <form className="space-y-4" noValidate onSubmit={saveClient}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell
                  autoComplete="off"
                  disabled={pending !== null}
                  error={errors.clientId}
                  label="Client ID"
                  name="sso-client-id"
                  onChange={change("clientId")}
                  placeholder="1234-abc.apps.googleusercontent.com"
                  readOnly={false}
                  value={values.clientId}
                />
                <FieldShell
                  autoComplete="off"
                  disabled={pending !== null}
                  error={errors.clientSecret}
                  helper={
                    signIn.hasClientSecret
                      ? "A secret is saved, encrypted. Leave this empty to keep it."
                      : "Stored encrypted, and never shown again."
                  }
                  ignorePasswordManagers
                  label="Client secret"
                  name="sso-client-secret"
                  onChange={change("clientSecret")}
                  readOnly={false}
                  type="password"
                  value={values.clientSecret}
                />
                <FieldShell
                  disabled={pending !== null}
                  error={errors.name}
                  helper='The sign-in button says "Continue with" this.'
                  label="Button name"
                  name="sso-name"
                  onChange={change("name")}
                  placeholder="Google"
                  readOnly={false}
                  value={values.name}
                />
                <FieldShell
                  disabled={pending !== null}
                  error={errors.workspaceDomains}
                  helper={
                    signIn.workspaceDomains.source === "env"
                      ? fromEnvHelper("GOOGLE_WORKSPACE_DOMAINS")
                      : "Optional. Only accounts in these Workspace domains get in. Empty uses the sign-up rule's domains."
                  }
                  label="Workspace domains"
                  name="workspace-domains"
                  onChange={change("workspaceDomains")}
                  placeholder={
                    view.signupRule.domains.join(", ") || "yourcompany.com"
                  }
                  readOnly={signIn.workspaceDomains.source === "env"}
                  value={
                    signIn.workspaceDomains.source === "env"
                      ? signIn.workspaceDomains.domains.join(", ")
                      : values.workspaceDomains
                  }
                />
              </div>
              {showOtherProvider ? (
                <div className="max-w-xl">
                  <FieldShell
                    disabled={pending !== null}
                    error={errors.issuer}
                    helper="Another OpenID Connect provider's issuer, such as https://yourcompany.okta.com. The Workspace checks apply to Google only."
                    label="Issuer"
                    name="sso-issuer"
                    onChange={change("issuer")}
                    placeholder="https://accounts.google.com"
                    readOnly={false}
                    value={values.issuer}
                  />
                </div>
              ) : null}
              <ActionRow>
                <ShellButton
                  disabled={pending !== null}
                  loading={pending === "client"}
                  type="submit"
                >
                  {pending === "client" ? "Saving..." : "Save sign-in settings"}
                </ShellButton>
                <ShellButton
                  disabled={pending !== null}
                  onClick={() => setShowOtherProvider((shown) => !shown)}
                  variant="ghost"
                >
                  {showOtherProvider ? "Use Google" : "Use another provider"}
                </ShellButton>
                {signIn.hasClientSecret ? (
                  <ShellButton
                    disabled={pending !== null}
                    loading={pending === "remove"}
                    onClick={() =>
                      void run(
                        "remove",
                        { clientId: "", issuer: "", removeClientSecret: true },
                        "Single sign-on was removed.",
                      )
                    }
                    variant="ghost"
                  >
                    Remove
                  </ShellButton>
                ) : null}
              </ActionRow>
            </form>
          )}
        </CheckItem>

        <CheckItem ok={null} title="3. Test sign-in">
          <p>
            Sign in with your own Google account in a new tab. It comes back to
            this page and says whether it worked. Use the same account you are
            signed in with now, or you will be signed in as the other one.
          </p>
          <ActionRow>
            <ShellButton
              disabled={pending !== null || !signIn.ready}
              loading={pending === "test"}
              onClick={() => void testSignIn()}
              variant="secondary"
            >
              Test sign-in
            </ShellButton>
          </ActionRow>
          {!signIn.ready ? (
            <p className="text-xs leading-5 text-(--tertiary)">
              Available once the client ID and secret are saved.
            </p>
          ) : null}
          <TestResult
            result={testError ? { message: testError, ok: false } : null}
          />
        </CheckItem>

        <CheckItem
          ok={signupLimited}
          title="4. Limit sign-up to your Workspace domain"
        >
          <p>
            {signupLimited
              ? `New accounts can only be made at ${view.signupRule.domains.join(", ")}. Google sign-in is held to the same domains unless other Workspace domains are given above.`
              : "Anyone who signs in for the first time gets an account under the sign-up rule. Set it to your Workspace's domain so only your organization gets in."}
          </p>
          <ShellButton href="/settings/organization" variant="secondary">
            Open the sign-up rule
          </ShellButton>
        </CheckItem>

        <CheckItem
          ok={signIn.ready ? !signIn.passwordSignIn : null}
          title="5. Turn password sign-in off, keeping a way in"
        >
          <p>
            With passwords off, Google decides who gets in: its two-step
            verification and offboarding apply. Keep one or two
            administrators&apos; addresses below; they can still use a password
            if Google is unavailable (a break-glass account).
          </p>
          {passwordLocked ? (
            <EnvLockedNotice variables={["PASSWORD_SIGN_IN"]}>
              <p>Password sign-in is {signIn.passwordSignIn ? "on" : "off"}.</p>
            </EnvLockedNotice>
          ) : (
            <div className="space-y-4">
              <div className="max-w-xl">
                <FieldShell
                  disabled={pending !== null}
                  error={errors.passwordAllowedEmails}
                  helper="Comma-separated. These addresses keep their password."
                  label="Break-glass addresses"
                  name="password-allowed-emails"
                  onChange={change("passwordAllowedEmails")}
                  placeholder="admin@yourcompany.com"
                  readOnly={false}
                  value={values.passwordAllowedEmails}
                />
              </div>
              {errors.passwordSignIn ? (
                <Feedback message={errors.passwordSignIn} tone="error" />
              ) : null}
              <ShellButton
                disabled={
                  pending !== null || (!signIn.ready && signIn.passwordSignIn)
                }
                loading={pending === "password"}
                onClick={() =>
                  void run(
                    "password",
                    {
                      passwordAllowedEmails: values.passwordAllowedEmails,
                      passwordSignIn: !signIn.passwordSignIn,
                    },
                    signIn.passwordSignIn
                      ? "Password sign-in is off, except for the break-glass addresses."
                      : "Password sign-in is on again.",
                  )
                }
                variant={signIn.passwordSignIn ? "primary" : "secondary"}
              >
                {signIn.passwordSignIn
                  ? "Turn password sign-in off"
                  : "Turn password sign-in back on"}
              </ShellButton>
            </div>
          )}
        </CheckItem>
      </SetupSteps>
    </div>
  );
}

/** The Workspace directory: service account, access, tests, admin group. */
export function GoogleDirectorySection({
  workspace,
}: {
  workspace: Workspace;
}) {
  const { save, view } = workspace;
  const { productName } = useBranding();
  const { directory, serviceAccount } = view;
  const project = googleProjectId(serviceAccount.email);
  const [values, setValues] = useState({
    adminGroup:
      view.adminGroup.source === "settings"
        ? (view.adminGroup.group ?? "")
        : "",
    adminSubject: directory.adminSubjectFromEnv
      ? ""
      : (directory.adminSubject ?? ""),
    customerId:
      directory.customerFromEnv || directory.customer === "my_customer"
        ? ""
        : directory.customer,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "error" | "success";
  } | null>(null);
  const [directoryTest, setDirectoryTest] =
    useState<DirectoryTestResult | null>(null);
  const [groupTest, setGroupTest] = useState<GroupTestResult | null>(null);

  function change(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: "" }));
      setNotice(null);
    };
  }

  async function saveFields(action: string, fields: SaveFields, done: string) {
    setPending(action);
    setNotice(null);

    const result = await save(fields);

    setErrors(result.fieldErrors);
    setPending(null);
    setNotice(
      result.ok
        ? { message: done, tone: "success" }
        : {
            message: saveFailureMessage(
              result.fieldErrors,
              result.error ?? null,
            ),
            tone: "error",
          },
    );
  }

  async function test(action: "test_directory" | "test_group") {
    setPending(action);

    try {
      const response = await fetch("/api/admin/google", {
        body: JSON.stringify(
          action === "test_group"
            ? {
                action,
                group: values.adminGroup || view.adminGroup.group || "",
              }
            : { action },
        ),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        result?: DirectoryTestResult & GroupTestResult;
      } | null;
      const result =
        payload?.result ??
        ({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          ok: false,
          status: response.status,
        } as const);

      if (action === "test_directory") {
        setDirectoryTest(result as DirectoryTestResult);
      } else {
        setGroupTest(result as GroupTestResult);
      }
    } catch {
      const failed = {
        message: GENERIC_ERROR_MESSAGE,
        ok: false,
        status: null,
      } as const;

      if (action === "test_directory") {
        setDirectoryTest(failed);
      } else {
        setGroupTest(failed);
      }
    } finally {
      setPending(null);
    }
  }

  const delegation = directory.mode === "delegation";

  return (
    <div className="space-y-5">
      {notice ? <Feedback message={notice.message} tone={notice.tone} /> : null}

      <SetupSteps>
        <CheckItem
          ok={serviceAccount.email !== null}
          title="1. The service account this site runs as"
        >
          {serviceAccount.email ? (
            <>
              <p>
                {serviceAccount.source === "metadata"
                  ? "This site runs on Google Cloud as this service account, with no key stored:"
                  : "This site uses the service account in GOOGLE_SERVICE_ACCOUNT_KEY:"}
              </p>
              <CopyValue label="Service account" value={serviceAccount.email} />
            </>
          ) : (
            <p>
              {serviceAccount.problem} Run the site on Cloud Run (or anywhere on
              Google Cloud) with its own service account, or set
              GOOGLE_SERVICE_ACCOUNT_KEY to a service account key.
            </p>
          )}
        </CheckItem>

        <CheckItem
          ok={directoryTest?.ok ?? null}
          title="2. Let it read the directory"
        >
          <p>
            <ExternalLink href={apiLibraryUrl("admin.googleapis.com", project)}>
              Enable the Admin SDK API
            </ExternalLink>
            , then use one of these.
          </p>
          <p>
            <strong>Recommended: a read-only administrator role.</strong> No
            domain-wide delegation.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open{" "}
              <ExternalLink href={ADMIN_ROLES_URL}>
                Admin console, Account, Admin roles
              </ExternalLink>
              , choose Create new role, and paste the name below.
            </li>
            <li>
              Under Admin API privileges, tick <strong>Users, Read</strong> and{" "}
              <strong>Groups, Read</strong>. Nothing else.
            </li>
            <li>
              Open the new role, choose Assign service accounts, and paste the
              service account from step 1.
            </li>
          </ol>
          <CopyValue label="Role name" value={directoryRoleName(productName)} />
          <p>
            <strong>Or: domain-wide delegation.</strong> Open{" "}
            <ExternalLink href={ADMIN_DELEGATION_URL}>
              Security, API controls, Domain-wide delegation
            </ExternalLink>{" "}
            and add the service account&apos;s client ID (its{" "}
            <ExternalLink
              href={consoleUrl("/iam-admin/serviceaccounts", project)}
            >
              unique ID
            </ExternalLink>
            ) with these scopes, then enter an administrator below.
          </p>
          <CopyValue
            label="Directory scopes"
            value={DIRECTORY_SCOPES.join(",")}
          />
          <p>
            With the admin role, also enter your Customer ID, shown under{" "}
            <ExternalLink href={ADMIN_ACCOUNT_SETTINGS_URL}>
              Admin console, Account, Account settings
            </ExternalLink>
            .
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={pending !== null || directory.adminSubjectFromEnv}
              error={errors.adminSubject}
              helper={
                directory.adminSubjectFromEnv
                  ? fromEnvHelper("GOOGLE_WORKSPACE_ADMIN_SUBJECT")
                  : "Only for domain-wide delegation. Leave empty with the admin role."
              }
              label="Act as administrator"
              name="admin-subject"
              onChange={change("adminSubject")}
              placeholder="admin@yourcompany.com"
              readOnly={directory.adminSubjectFromEnv}
              value={
                directory.adminSubjectFromEnv
                  ? (directory.adminSubject ?? "")
                  : values.adminSubject
              }
            />
            <FieldShell
              disabled={pending !== null || directory.customerFromEnv}
              error={errors.customerId}
              helper={
                directory.customerFromEnv
                  ? fromEnvHelper("GOOGLE_WORKSPACE_CUSTOMER_ID")
                  : "Needed with the admin role (starts with C). Optional with delegation."
              }
              label="Customer ID"
              name="customer-id"
              onChange={change("customerId")}
              placeholder="my_customer"
              readOnly={directory.customerFromEnv}
              value={
                directory.customerFromEnv
                  ? directory.customer
                  : values.customerId
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <ShellButton
              disabled={pending !== null}
              loading={pending === "access"}
              onClick={() =>
                void saveFields(
                  "access",
                  {
                    ...(directory.adminSubjectFromEnv
                      ? {}
                      : { adminSubject: values.adminSubject }),
                    ...(directory.customerFromEnv
                      ? {}
                      : { customerId: values.customerId }),
                  },
                  "Saved.",
                )
              }
              variant="secondary"
            >
              Save directory access
            </ShellButton>
            <ShellButton
              disabled={pending !== null || serviceAccount.email === null}
              loading={pending === "test_directory"}
              onClick={() => void test("test_directory")}
            >
              {pending === "test_directory"
                ? "Testing..."
                : "Test directory access"}
            </ShellButton>
          </div>
          {directoryTest ? (
            directoryTest.ok ? (
              <Feedback
                message={`The directory can be read (${delegation ? "domain-wide delegation" : "admin role"}). Found: ${directoryTest.people
                  .map((person) => `${person.name} <${person.email}>`)
                  .join(", ")}.`}
                tone="success"
              />
            ) : (
              <Feedback message={directoryTest.message} tone="error" />
            )
          ) : null}
        </CheckItem>

        <CheckItem
          ok={directory.enabled}
          title="3. Suggest colleagues as recipients"
        >
          <p>
            When it is on, anyone sending a document sees people from the
            directory as they type a signer&apos;s or copy recipient&apos;s name
            or address. Outside recipients are still typed in full.
          </p>
          {directory.enabledSource === "env" ? (
            <EnvLockedNotice variables={["GOOGLE_WORKSPACE_DIRECTORY"]} />
          ) : (
            <ShellButton
              disabled={pending !== null}
              loading={pending === "enable"}
              onClick={() =>
                void saveFields(
                  "enable",
                  { directoryEnabled: !directory.enabled },
                  directory.enabled
                    ? "Suggestions are off."
                    : "Suggestions are on.",
                )
              }
              variant={directory.enabled ? "secondary" : "primary"}
            >
              {directory.enabled
                ? "Turn suggestions off"
                : "Turn suggestions on"}
            </ShellButton>
          )}
        </CheckItem>

        <CheckItem
          ok={view.adminGroup.group !== null ? (groupTest?.ok ?? null) : null}
          title="4. Optional: an administrator group"
        >
          <p>
            Members of this Google Group become administrators here when they
            sign in with Google, and administrators who leave it stop being one.
            The last administrator always stays, and each change is in the site
            audit trail. Password sign-ins are not changed, so a break-glass
            account keeps its role. It needs the directory to be readable (step
            2).
          </p>
          <div className="max-w-xl">
            <FieldShell
              disabled={pending !== null || view.adminGroup.source === "env"}
              error={errors.adminGroup ?? view.adminGroup.problem}
              helper={
                view.adminGroup.source === "env"
                  ? fromEnvHelper("GOOGLE_ADMIN_GROUP")
                  : "The group's email address. Empty turns this off."
              }
              label="Administrator group"
              name="admin-group"
              onChange={change("adminGroup")}
              placeholder="signudoc-admins@yourcompany.com"
              readOnly={view.adminGroup.source === "env"}
              value={
                view.adminGroup.source === "env"
                  ? (view.adminGroup.group ?? "")
                  : values.adminGroup
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {view.adminGroup.source !== "env" ? (
              <ShellButton
                disabled={pending !== null}
                loading={pending === "group"}
                onClick={() =>
                  void saveFields(
                    "group",
                    { adminGroup: values.adminGroup },
                    values.adminGroup
                      ? "Saved. It applies from each person's next Google sign-in."
                      : "The administrator group is off.",
                  )
                }
                variant="secondary"
              >
                Save group
              </ShellButton>
            ) : null}
            <ShellButton
              disabled={
                pending !== null ||
                serviceAccount.email === null ||
                !(values.adminGroup || view.adminGroup.group)
              }
              loading={pending === "test_group"}
              onClick={() => void test("test_group")}
            >
              {pending === "test_group" ? "Testing..." : "Test group lookup"}
            </ShellButton>
          </div>
          {groupTest ? (
            groupTest.ok ? (
              <Feedback
                message={
                  groupTest.isMember
                    ? `You are in ${groupTest.group}, so you stay an administrator when you sign in with Google.`
                    : `You are not in ${groupTest.group}. When you next sign in with Google you would stop being an administrator, unless you are the last one. Add yourself to the group first.`
                }
                tone={groupTest.isMember ? "success" : "error"}
              />
            ) : (
              <Feedback message={groupTest.message} tone="error" />
            )
          ) : null}
        </CheckItem>
      </SetupSteps>
    </div>
  );
}
