import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmailPanel } from "@/components/settings/email-setup-panel";
import { GoogleAddonPanel } from "@/components/settings/google-addon-panel";
import { GoogleDrivePanel } from "@/components/settings/google-drive-panel";
import {
  GoogleDirectoryPanel,
  GoogleSignInPanel,
} from "@/components/settings/google-workspace-panel";
import {
  describeStorageBrand,
  INTEGRATIONS,
} from "@/components/settings/integrations-catalog";
import { StoragePanel } from "@/components/settings/storage-panel";
import { getGoogleAddonView } from "@/lib/google-addon";
import { getGoogleDriveView } from "@/lib/google-drive";
import { getGoogleWorkspaceView } from "@/lib/google-workspace";
import { describeStorageDriver } from "@/lib/storage-check";

import { requireSettingsAdmin } from "../../require-admin";
import { getIntegrationStates } from "../statuses";

type IntegrationPageProps = {
  params: Promise<{ integration: string }>;
  searchParams: Promise<{ error?: string | string[]; signin?: string }>;
};

export async function generateMetadata({
  params,
}: IntegrationPageProps): Promise<Metadata> {
  const { integration } = await params;

  return {
    title:
      INTEGRATIONS.find((item) => item.id === integration)?.name ??
      "Integrations",
  };
}

// Settings, Integrations, one service: its own page, opened from the
// Integrations overview.
export default async function IntegrationPage({
  params,
  searchParams,
}: IntegrationPageProps) {
  const { integration } = await params;
  const info = INTEGRATIONS.find((item) => item.id === integration);

  if (!info) {
    notFound();
  }

  // Slack is set up with the rest of notifications.
  if (info.id === "slack") {
    redirect("/settings/notifications");
  }

  const { settings } = await requireSettingsAdmin();

  // The hosted service runs its own Google and storage.
  if (settings.hosted && info.id !== "email") {
    redirect("/settings/integrations");
  }

  const state = (await getIntegrationStates())[info.id];
  let panel: ReactNode = null;

  switch (info.id) {
    case "google-sign-in": {
      const { error, signin } = await searchParams;
      const code = Array.isArray(error) ? error[0] : error;

      panel = (
        <GoogleSignInPanel
          detail={state.detail}
          initialView={await getGoogleWorkspaceView()}
          status={state.status}
          testOutcome={
            signin === "ok"
              ? { ok: true }
              : code
                ? { error: code.slice(0, 80), ok: false }
                : null
          }
        />
      );
      break;
    }
    case "google-directory":
      panel = (
        <GoogleDirectoryPanel
          detail={state.detail}
          initialView={await getGoogleWorkspaceView()}
          status={state.status}
        />
      );
      break;
    case "google-drive":
      panel = (
        <GoogleDrivePanel
          detail={state.detail}
          initialView={await getGoogleDriveView()}
          status={state.status}
        />
      );
      break;
    case "google-addon":
      panel = (
        <GoogleAddonPanel
          detail={state.detail}
          initialView={await getGoogleAddonView()}
          status={state.status}
        />
      );
      break;
    case "email":
      panel = <EmailPanel detail={state.detail} status={state.status} />;
      break;
    case "storage": {
      const storage = describeStorageDriver();
      const { brand, name } = describeStorageBrand(storage.driver);

      panel = (
        <StoragePanel
          brand={brand}
          detail={state.detail}
          name={name}
          status={state.status}
          storage={storage}
        />
      );
      break;
    }
  }

  return (
    <>
      <Link
        className="inline-flex w-fit items-center gap-1 rounded-lg text-sm font-semibold text-(--secondary) transition hover:text-(--fg)"
        href="/settings/integrations"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        All integrations
      </Link>
      {panel}
    </>
  );
}
