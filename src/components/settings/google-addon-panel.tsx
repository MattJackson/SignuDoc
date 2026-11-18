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
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { GoogleAddonView } from "@/lib/google-addon";

// Settings, Google Workspace, the add-on, and the onboarding step of the
// same name: SignuDoc in the Gmail and Drive side panel, served by this
// site. The checklist gives the deployment JSON with this site's URLs, the
// gcloud commands that deploy it, how an administrator installs it for the
// whole domain, and the two values from Google the site checks every
// request against. The full guide is docs/google-workspace.md.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const MARKETPLACE_SDK_URL =
  "https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com";
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
                This is the add-on&apos;s deployment, with this site&apos;s
                address in every URL. Save it as{" "}
                <code>signudoc-addon.json</code>.
              </p>
              <pre className="max-h-72 overflow-auto rounded-xl bg-white p-3 font-mono text-[0.75rem] leading-5 text-(--fg)">
                {json}
              </pre>
              <div className="flex flex-wrap gap-2">
                <CopyButton label="deployment JSON" value={json} />
                {/* A plain link: the file comes from an API route, not a page. */}
                <a
                  className="btn-quiet"
                  download="signudoc-addon.json"
                  href="/api/admin/google/addon?download=1"
                >
                  Download signudoc-addon.json
                </a>
              </div>
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
            In a terminal signed in to the Google Cloud project that will own
            the add-on (the one this site runs in is a good choice), run:
          </p>
          <ul className="space-y-3">
            {view.commands.map((entry) => (
              <li className="space-y-1" key={entry.command}>
                <CopyValue label={entry.purpose} value={entry.command} />
              </li>
            ))}
          </ul>
        </CheckItem>

        <CheckItem ok={view.ready} title="3. Paste what Google printed">
          <p>
            <code>gcloud workspace-add-ons get-authorization</code> prints the
            add-on&apos;s service account (serviceAccountEmail) and its OAuth
            client ID (oauthClientId). Every request to this site must carry an
            ID token for that service account, and the user&apos;s ID token must
            be for that client, or it is turned away.
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
          <p>
            <code>gcloud workspace-add-ons deployments install</code> installs
            it for you only, to try it. To give it to everyone, privately and
            without publishing it:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the same project, enable the{" "}
              <ExternalLink href={MARKETPLACE_SDK_URL}>
                Google Workspace Marketplace SDK
              </ExternalLink>
              . Under App configuration, set the visibility to{" "}
              <strong>Private</strong>, choose Google Workspace add-on, pick{" "}
              <strong>Deploy using an alternate runtime</strong>, and enter the
              deployment ID, <code>signudoc</code>. Fill in Store listing and
              publish it; a private app is only listed in your domain and is not
              reviewed by Google.
            </li>
            <li>
              A Workspace administrator opens{" "}
              <ExternalLink href={ADMIN_MARKETPLACE_APPS_URL}>
                Admin console, Apps, Google Workspace Marketplace apps
              </ExternalLink>
              , finds it under the apps for your domain, and installs it for
              everyone or for chosen organizational units. Users then see it in
              Gmail and Drive without being asked to allow it.
            </li>
          </ol>
          <p>
            People use it with their SignuDoc account, matched by their Google
            address. Anyone who has none yet is asked to sign in to SignuDoc
            once.
          </p>
        </CheckItem>
      </SetupSteps>

      {view.endpoints.length > 0 ? (
        <details className="text-sm leading-6 text-(--secondary)">
          <summary className="cursor-pointer font-semibold text-(--fg)">
            The URLs Google calls, and the scopes it asks for
          </summary>
          <ul className="mt-2 space-y-1">
            {view.endpoints.map((endpoint) => (
              <li key={endpoint.trigger}>
                <code>{endpoint.url}</code>
              </li>
            ))}
          </ul>
          <ul className="mt-2 space-y-1">
            {view.scopes.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
