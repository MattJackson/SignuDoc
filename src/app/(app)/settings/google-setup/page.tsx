import type { Metadata } from "next";

import { GoogleSetupPanel } from "@/components/settings/google-setup-panel";
import { getGoogleDriveView } from "@/lib/google-drive";
import { getGoogleWorkspaceView } from "@/lib/google-workspace";
import {
  describeSetupTarget,
  toSetupTargetView,
} from "@/lib/google-workspace-setup";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Google Workspace setup" };

type GoogleSetupPageProps = {
  searchParams: Promise<{
    code?: string | string[];
    error?: string | string[];
    state?: string | string[];
  }>;
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

// Settings, Google Workspace setup: automatic or manual, and where Google
// sends the administrator back to after the automatic setup's sign-in.
export default async function GoogleSetupPage({
  searchParams,
}: GoogleSetupPageProps) {
  await requireSettingsAdmin({ selfHostedOnly: true });

  const query = await searchParams;
  const [workspace, drive, target] = await Promise.all([
    getGoogleWorkspaceView(),
    getGoogleDriveView(),
    describeSetupTarget(),
  ]);

  return (
    <GoogleSetupPanel
      callback={{
        code: first(query.code),
        error: first(query.error)?.slice(0, 80) ?? null,
        state: first(query.state),
      }}
      drive={drive}
      target={toSetupTargetView(target)}
      workspace={workspace}
    />
  );
}
