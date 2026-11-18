import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getBackupSettingsView } from "@/lib/backup-config";
import { getGoogleDriveView } from "@/lib/google-drive";
import { getGoogleWorkspaceView } from "@/lib/google-workspace";
import {
  getOnboardingState,
  isOnboardingStepId,
  type OnboardingStepId,
} from "@/lib/onboarding/steps";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { getSealSettingsView } from "@/lib/seal-setup";
import { readStoredSettings, resolveSettings } from "@/lib/settings";
import { describeStorageDriver } from "@/lib/storage-check";

export const metadata: Metadata = {
  title: "Set up",
};

type OnboardingPageProps = {
  searchParams: Promise<{ step?: string | string[] }>;
};

// Onboarding, where first-run setup ends: the rest of what an administrator
// sets up, one step at a time (lib/onboarding/steps.ts).
export default async function OnboardingPage({
  searchParams,
}: OnboardingPageProps) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  if (!(await isAdminUser(session.user.id))) {
    redirect("/dashboard");
  }

  const { step: rawStep } = await searchParams;
  const requested = Array.isArray(rawStep) ? rawStep[0] : rawStep;
  const [steps, googleWorkspace, googleDrive, stored, backups, seal] =
    await Promise.all([
      getOnboardingState(),
      getGoogleWorkspaceView(),
      getGoogleDriveView(),
      readStoredSettings(),
      getBackupSettingsView(),
      getSealSettingsView(),
    ]);
  // With no step named, the first one not done yet.
  const current: OnboardingStepId | "done" =
    requested === "done"
      ? "done"
      : isOnboardingStepId(requested)
        ? requested
        : (steps.find((step) => step.status !== "done")?.id ?? "done");

  return (
    <OnboardingShell
      current={current}
      data={{
        backups,
        googleDrive,
        googleWorkspace,
        organization: toOrganizationSettingsView(resolveSettings(stored)),
        seal,
        storage: describeStorageDriver(),
      }}
      steps={steps}
    />
  );
}
