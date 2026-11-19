"use client";

import { useRouter } from "next/navigation";

import { IntegrationPanel } from "@/components/settings/integration-kit";
import {
  GoogleWorkspaceSetup,
  type GoogleSetupCallback,
} from "@/components/settings/google-setup";
import { needsCustomerId } from "@/lib/google-customer";
import type { GoogleDriveView } from "@/lib/google-drive";
import type { GoogleWorkspaceView } from "@/lib/google-workspace";
import type { SetupTargetView } from "@/lib/google-workspace-setup";

/** Settings, Google Workspace setup, on its own page. */
export function GoogleSetupPanel({
  callback,
  drive,
  target,
  workspace,
}: {
  callback: GoogleSetupCallback;
  drive: GoogleDriveView;
  target: SetupTargetView;
  workspace: GoogleWorkspaceView;
}) {
  const router = useRouter();
  const ready =
    workspace.signIn.ready &&
    drive.picker.ready &&
    !needsCustomerId(workspace.directory);

  return (
    <IntegrationPanel
      brand="google"
      description="Google sign-in, the Workspace directory, the Drive Picker and a Shared Drive for executed copies, set up together. Run it again whenever something needs fixing; what is in place is kept."
      detail={
        ready
          ? "Sign-in, the directory and the Picker are set up."
          : "Not everything is set up yet."
      }
      id="google-setup"
      name="Google Workspace setup"
      status={ready ? "connected" : "not_set_up"}
    >
      <GoogleWorkspaceSetup
        callback={callback}
        drive={drive}
        onChanged={() => router.refresh()}
        returnTo="/settings/google-setup"
        target={target}
        workspace={workspace}
      />
    </IntegrationPanel>
  );
}
