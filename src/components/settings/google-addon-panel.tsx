"use client";

import { useState } from "react";

import {
  CheckItem,
  CopyButton,
  CopyValue,
  ExternalLink,
  IntegrationPanel,
  Notice,
  SetupSteps,
  type ConnectionStatus,
} from "@/components/settings/integration-kit";
import { useBranding } from "@/components/layout/branding-provider";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import {
  apiLibraryUrl,
  consoleUrl,
  googleProjectId,
} from "@/lib/google-console";
import type { GoogleAddonView } from "@/lib/google-addon";

// Settings, Google Workspace, the add-on, and the onboarding step of the
// same name: SignuDoc in the Gmail and Drive side panel, served by this
// site. The checklist gives the deployment JSON with this site's URLs, the
// gcloud commands that deploy it, how an administrator installs it for the
// whole domain, and the two values from Google the site checks every
// request against. The full guide is docs/google-workspace.md.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const MARKETPLACE_SDK_API = "appsmarket-component.googleapis.com";
const MARKETPLACE_SDK_PATH =
  "/apis/api/appsmarket-component.googleapis.com/googleapps_sdk";
const DEPLOYMENT_ID = "signudoc";
const DEPLOYMENT_FILE = "signudoc-addon.json";
const ADMIN_MARKETPLACE_APPS_URL =
  "https://admin.google.com/ac/apps/gmail/marketplace/apps";

function fromEnvHelper(name: string) {
  return `Set by the ${name} environment variable.`;
}

/** Settings, Integrations, Gmail and Drive add-on. */
export function GoogleAddonPanel({
  detail,
  initialView,
  status,
}: {
  detail: string;
  initialView: GoogleAddonView;
  status: ConnectionStatus;
}) {
  return (
    <IntegrationPanel
      brand="gmail"
      description="Optional. Puts SignuDoc in the side panel of Gmail and Google Drive: send an attachment or a Drive file for signature in two clicks, see the contracts you have with the sender of an email, and nudge a signer. This site serves it; there is no Apps Script to keep."
      detail={detail}
      id="google-addon"
      name="Gmail and Drive add-on"
      status={status}
    >
      <GoogleAddonSection initialView={initialView} />
    </IntegrationPanel>
  );
}

/** The add-on's steps, in Settings and in onboarding. */
export function GoogleAddonSection({
  initialView,
}: {
  initialView: GoogleAddonView;
}) {
  const [view, setView] = useState(initialView);
  const { productName } = useBranding();
  const project = googleProjectId(initialView.siteServiceAccountEmail);
  const [values, setValues] = useState({
    clientId:
      initialView.clientId.source === "settings"
        ? (initialView.clientId.value ?? "")
        : "",
    serviceAccount:
      initialView.serviceAccount.source === "settings"
        ? (initialView.serviceAccount.value ?? "")
        : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "error" | "success";
  } | null>(null);
  const json = view.deployment
    ? JSON.stringify(view.deployment, null, 2)
    : null;
  const serviceAccountLocked = view.serviceAccount.source === "env";
  const clientIdLocked = view.clientId.source === "env";

  function change(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: "" }));
      setNotice(null);
    };
  }

  async function save() {
    setSaving(true);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/google/addon", {
        body: JSON.stringify({
          ...(clientIdLocked ? {} : { clientId: values.clientId }),
          ...(serviceAccountLocked
            ? {}
            : { serviceAccount: values.serviceAccount }),
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        view?: GoogleAddonView;
      } | null;

      if (!response.ok || !payload?.view) {
        setErrors(payload?.fieldErrors ?? {});
        setNotice({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setView(payload.view);
      setErrors({});
      setNotice({
        message: payload.view.ready
          ? "Saved. The add-on's requests are checked against these from now on."
          : "Saved. Both values are needed before the add-on answers.",
        tone: "success",
      });
    } catch {
      setNotice({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {notice ? <Notice tone={notice.tone}>{notice.message}</Notice> : null}

      <SetupSteps>
        <CheckItem ok={json !== null} title="1. The deployment">
          {json ? (
            <>
              <p>
                Download the deployment, or copy it into a file with the name
                below.
              </p>
              <pre className="max-h-72 overflow-auto rounded-xl bg-white p-3 font-mono text-[0.75rem] leading-5 text-(--fg)">
                {json}
              </pre>
              <div className="flex flex-wrap gap-2">
                <CopyButton label="deployment JSON" value={json} />
                {/* A plain link: the file comes from an API route, not a page. */}
                <a
                  className="btn-quiet"
                  download={DEPLOYMENT_FILE}
                  href="/api/admin/google/addon?download=1"
                >
                  Download {DEPLOYMENT_FILE}
                </a>
              </div>
              <CopyValue label="File name" value={DEPLOYMENT_FILE} />
            </>
          ) : (
            <p>
              This site does not know its own address yet. Set APP_URL (or
              BETTER_AUTH_URL) where it runs; the add-on&apos;s URLs are built
              from it.
            </p>
          )}
        </CheckItem>

        <CheckItem ok={null} title="2. Deploy it with gcloud">
          <p>
            In a terminal, run these in order
            {project ? ", in the project this site runs in" : ""}:
          </p>
          <ul className="space-y-3">
            {project ? (
              <li>
                <CopyValue
                  label="Select the project"
                  value={`gcloud config set project ${project}`}
                />
              </li>
            ) : null}
            {view.commands.map((entry) => (
              <li className="space-y-1" key={entry.command}>
                <CopyValue label={entry.purpose} value={entry.command} />
              </li>
            ))}
          </ul>
        </CheckItem>

        <CheckItem ok={view.ready} title="3. Paste what Google printed">
          <p>
            Run the get-authorization command above, and paste its
            serviceAccountEmail and oauthClientId here.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              autoComplete="off"
              disabled={saving || serviceAccountLocked}
              error={errors.serviceAccount}
              helper={
                serviceAccountLocked
                  ? fromEnvHelper("GOOGLE_ADDON_SERVICE_ACCOUNT")
                  : "Looks like service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
              }
              label="Add-on service account"
              name="addon-service-account"
              onChange={change("serviceAccount")}
              placeholder="service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
              readOnly={serviceAccountLocked}
              value={
                serviceAccountLocked
                  ? (view.serviceAccount.value ?? "")
                  : values.serviceAccount
              }
            />
            <FieldShell
              autoComplete="off"
              disabled={saving || clientIdLocked}
              error={errors.clientId}
              helper={
                clientIdLocked
                  ? fromEnvHelper("GOOGLE_ADDON_CLIENT_ID")
                  : "A long number, from the same output."
              }
              label="Add-on OAuth client ID"
              name="addon-client-id"
              onChange={change("clientId")}
              placeholder="123456789012345678901"
              readOnly={clientIdLocked}
              value={
                clientIdLocked ? (view.clientId.value ?? "") : values.clientId
              }
            />
          </div>
          {serviceAccountLocked && clientIdLocked ? null : (
            <ShellButton
              className="w-fit"
              loading={saving}
              onClick={() => void save()}
              variant="secondary"
            >
              {saving ? "Saving..." : "Save"}
            </ShellButton>
          )}
        </CheckItem>

        <CheckItem ok={null} title="4. Install it for your organization">
          <p>To give it to everyone, privately and without publishing it:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <ExternalLink href={apiLibraryUrl(MARKETPLACE_SDK_API, project)}>
                Enable the Google Workspace Marketplace SDK
              </ExternalLink>{" "}
              in the same project.
            </li>
            <li>
              Open its{" "}
              <ExternalLink href={consoleUrl(MARKETPLACE_SDK_PATH, project)}>
                App configuration
              </ExternalLink>
              : set the visibility to <strong>Private</strong>, choose Google
              Workspace add-on, pick{" "}
              <strong>Deploy using an alternate runtime</strong> and paste the
              deployment ID.
            </li>
            <li>
              Fill in the Store listing, using the name below, and publish.
            </li>
            <li>
              In{" "}
              <ExternalLink href={ADMIN_MARKETPLACE_APPS_URL}>
                Admin console, Apps, Google Workspace Marketplace apps
              </ExternalLink>
              , find it and install it for everyone or for chosen organizational
              units.
            </li>
          </ol>
          <div className="grid gap-4 sm:grid-cols-2">
            <CopyValue label="Deployment ID" value={DEPLOYMENT_ID} />
            <CopyValue label="App name" value={productName} />
          </div>
        </CheckItem>
      </SetupSteps>

      {view.endpoints.length > 0 ? (
        <details className="text-sm leading-6 text-(--secondary)">
          <summary className="cursor-pointer font-semibold text-(--fg)">
            The URLs Google calls, and the scopes it asks for
          </summary>
          <div className="mt-3 grid gap-3">
            {view.endpoints.map((endpoint) => (
              <CopyValue
                key={endpoint.trigger}
                label={endpoint.trigger}
                value={endpoint.url}
              />
            ))}
            {view.scopes.map((scope) => (
              <CopyValue key={scope} label="Scope" value={scope} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
