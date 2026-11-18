"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type {
  DirectoryTestResult,
  GoogleWorkspaceView,
  GroupTestResult,
} from "@/lib/google-workspace";

// Settings, Google Workspace, and the onboarding steps of the same name.
// Each part is a step-by-step checklist: what to do in Google's consoles,
// with this site's own values to paste there, and live checks of what is
// already in place. Values fixed by an environment variable are shown and
// locked. A Google Drive section can be added after the directory one, on
// the same service account.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const GOOGLE_AUTH_CLIENTS_URL = "https://console.cloud.google.com/auth/clients";
const GOOGLE_AUTH_AUDIENCE_URL =
  "https://console.cloud.google.com/auth/audience";
const ADMIN_ROLES_URL = "https://admin.google.com/ac/roles";
const ADMIN_DELEGATION_URL =
  "https://admin.google.com/ac/owl/domainwidedelegation";
const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
];

type SaveResult = { fieldErrors: Record<string, string>; ok: boolean };

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
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return { fieldErrors: payload?.fieldErrors ?? {}, ok: false };
      }

      setView(payload.view);

      return { fieldErrors: {}, ok: true };
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
      return { fieldErrors: {}, ok: false };
    }
  }

  return { error, save, view };
}

type Workspace = ReturnType<typeof useGoogleWorkspace>;

/** The whole Google Workspace area of Settings. */
export function GoogleWorkspacePanel({
  initialView,
}: {
  initialView: GoogleWorkspaceView;
}) {
  const workspace = useGoogleWorkspace(initialView);

  return (
    <section
      className="panel scroll-mt-6 space-y-8 p-6 sm:p-8"
      data-animate="enter"
      id="google-workspace"
    >
      <div className="space-y-2">
        <p className="section-eyebrow">Administrator</p>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          Google Workspace
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Let everyone in your organization sign in with their Google account,
          suggest colleagues as recipients, and make a Google Group&apos;s
          members administrators. The full guide is in docs/google-workspace.md.
        </p>
      </div>
      <GoogleSignInSection workspace={workspace} />
      <GoogleDirectorySection workspace={workspace} />
    </section>
  );
}

function StatusPill({ ok, children }: { children: ReactNode; ok: boolean }) {
  return (
    <span className={`pill ${ok ? "pill-success" : "pill-warning"}`}>
      {children}
    </span>
  );
}

function CheckItem({
  children,
  ok,
  title,
}: {
  children: ReactNode;
  ok: boolean | null;
  title: string;
}) {
  return (
    <li className="space-y-3 rounded-2xl bg-(--surface) px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold text-(--fg)">{title}</span>
        {ok === null ? null : (
          <StatusPill ok={ok}>{ok ? "Done" : "To do"}</StatusPill>
        )}
      </div>
      <div className="space-y-3 text-sm leading-6 text-(--secondary)">
        {children}
      </div>
    </li>
  );
}

function ExternalLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className="font-semibold text-(--accent-ink) underline underline-offset-4"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code
        aria-label={label}
        className="rounded-lg bg-white px-2 py-1 font-mono text-[0.8rem] break-all text-(--fg)"
      >
        {value}
      </code>
      <button
        className="btn-quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
          });
        }}
        type="button"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Feedback({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "success";
}) {
  return (
    <p
      className={`notice ${tone === "success" ? "notice-success" : "notice-danger"}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

function fromEnvHelper(name: string) {
  return `Set by the ${name} environment variable.`;
}

/** Google sign-in: the OAuth client, the sign-up rule, and passwords. */
export function GoogleSignInSection({ workspace }: { workspace: Workspace }) {
  const { error, save, view } = workspace;
  const { signIn } = view;
  const locked = signIn.source === "env";
  const passwordLocked = signIn.passwordSource === "env";
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
      "Saved. Sign-in uses the new settings within a minute, with no restart.",
    );
  }

  return (
    <div
      className="space-y-5 border-t border-(--border) pt-8"
      id="google-sign-in"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Google sign-in
        </h3>
        <StatusPill ok={signIn.ready}>
          {signIn.ready ? "On" : "Not set up"}
        </StatusPill>
      </div>

      {error ? <Feedback message={error} tone="error" /> : null}
      {notice ? <Feedback message={notice} tone="success" /> : null}

      <ol className="space-y-3">
        <CheckItem ok={signIn.ready} title="1. Create the OAuth client">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the Google Cloud console, open{" "}
              <ExternalLink href={GOOGLE_AUTH_AUDIENCE_URL}>
                Google Auth Platform, Audience
              </ExternalLink>{" "}
              and set the user type to <strong>Internal</strong>, so only
              accounts in your Workspace can use it.
            </li>
            <li>
              Open{" "}
              <ExternalLink href={GOOGLE_AUTH_CLIENTS_URL}>
                Clients
              </ExternalLink>
              , choose Create client, and pick <strong>Web application</strong>.
            </li>
            <li>
              Under Authorized redirect URIs, add exactly:
              {view.redirectUri ? (
                <CopyValue label="Redirect URI" value={view.redirectUri} />
              ) : (
                <span className="block">
                  This site does not know its own address yet. Set APP_URL (or
                  BETTER_AUTH_URL) where it runs; the redirect URI is that
                  address followed by /api/auth/callback/sso.
                </span>
              )}
            </li>
            <li>
              The scopes are the basic ones: <code>openid</code>,{" "}
              <code>email</code> and <code>profile</code>. Nothing needs to be
              verified by Google for an Internal app.
            </li>
            <li>Copy the client ID and client secret into the form below.</li>
          </ol>

          {locked ? (
            <p>
              Single sign-on is set by the SSO_ISSUER, SSO_CLIENT_ID and
              SSO_CLIENT_SECRET environment variables where this site runs, so
              it is changed there. Issuer: <code>{signIn.issuer}</code>.
            </p>
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
              <div className="flex flex-wrap gap-2">
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
              </div>
            </form>
          )}
        </CheckItem>

        <CheckItem
          ok={signupLimited}
          title="2. Limit sign-up to your Workspace domain"
        >
          <p>
            {signupLimited
              ? `New accounts can only be made at ${view.signupRule.domains.join(", ")}. Google sign-in is held to the same domains unless other Workspace domains are given above.`
              : "Anyone who signs in for the first time gets an account under the sign-up rule. Set it to your Workspace's domain so only your organization gets in."}
          </p>
          <ShellButton href="/settings#organization" variant="ghost">
            Open the sign-up rule
          </ShellButton>
        </CheckItem>

        <CheckItem
          ok={signIn.ready ? !signIn.passwordSignIn : null}
          title="3. Turn password sign-in off, keeping a way in"
        >
          <p>
            With passwords off, Google decides who gets in: its MFA and
            offboarding apply. Keep one or two administrators&apos; addresses
            below; they can still use a password if Google is unavailable (a
            break-glass account).
          </p>
          {passwordLocked ? (
            <p>
              {fromEnvHelper("PASSWORD_SIGN_IN")} Password sign-in is{" "}
              {signIn.passwordSignIn ? "on" : "off"}.
            </p>
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
      </ol>
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
  const { directory, serviceAccount } = view;
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
        : { message: "Check the highlighted fields.", tone: "error" },
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
    <div
      className="space-y-5 border-t border-(--border) pt-8"
      id="google-directory"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Workspace directory and admin group
        </h3>
        <StatusPill ok={directory.enabled}>
          {directory.enabled ? "Suggestions on" : "Off"}
        </StatusPill>
      </div>

      {notice ? <Feedback message={notice.message} tone={notice.tone} /> : null}

      <ol className="space-y-3">
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
            <strong>Recommended: a read-only administrator role.</strong> No
            domain-wide delegation, so the service account can never act as
            anyone.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the Google Admin console, open{" "}
              <ExternalLink href={ADMIN_ROLES_URL}>
                Account, Admin roles
              </ExternalLink>{" "}
              and choose Create new role. Name it, for example, &quot;SignuDoc
              directory reader&quot;.
            </li>
            <li>
              Under Admin API privileges, tick <strong>Users, Read</strong> and{" "}
              <strong>Groups, Read</strong>. Nothing else.
            </li>
            <li>
              Open the new role, choose Assign service accounts, and paste the
              service account above.
            </li>
          </ol>
          <p>
            <strong>Or: domain-wide delegation.</strong> In{" "}
            <ExternalLink href={ADMIN_DELEGATION_URL}>
              Security, API controls, Domain-wide delegation
            </ExternalLink>
            , add the service account&apos;s client ID with only these scopes,
            and name an administrator for it to read the directory as.
          </p>
          <CopyValue
            label="Directory scopes"
            value={DIRECTORY_SCOPES.join(",")}
          />
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
                  : "Optional. Empty means your own Workspace (my_customer)."
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
            <p>{fromEnvHelper("GOOGLE_WORKSPACE_DIRECTORY")}</p>
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
              error={errors.adminGroup}
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
      </ol>
    </div>
  );
}
