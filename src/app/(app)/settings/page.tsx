import { BackupSettingsSection } from "@/components/settings/backup-settings-section";
import { GoogleWorkspacePanel } from "@/components/settings/google-workspace-panel";
import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SealSettingsSection } from "@/components/settings/seal-settings-section";
import { SettingsShell } from "@/components/settings/settings-shell";
import { SetupChecklist } from "@/components/settings/setup-checklist";
import { TeamsPanel } from "@/components/settings/teams-panel";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { isAdminUser } from "@/lib/auth/admin";
import { getBackupSettingsView } from "@/lib/backup-config";
import { getAuthSession } from "@/lib/auth/server";
import { getGoogleWorkspaceView } from "@/lib/google-workspace";
import { getOnboardingState } from "@/lib/onboarding/steps";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { getSealSettingsView } from "@/lib/seal-setup";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { usesTwoFactor } from "@/lib/sign-in-security";
import { getUpdateStatus } from "@/lib/software-update";

export default async function SettingsPage() {
  const session = await getAuthSession();
  const isAdmin = session ? await isAdminUser(session.user.id) : false;
  const settings = await getSettings();
  const backupView = isAdmin ? await getBackupSettingsView() : null;
  // The hosted service seals with its operator's certificate.
  const sealView =
    isAdmin && !settings.hosted ? await getSealSettingsView() : null;
  const [onboarding, googleWorkspace] =
    isAdmin && !settings.hosted
      ? await Promise.all([getOnboardingState(), getGoogleWorkspaceView()])
      : [null, null];

  return (
    <div className="space-y-8">
      <SettingsShell
        initialProfile={{
          email: session?.user.email ?? "",
          fullName: session?.user.name ?? "",
        }}
        twoFactor={{
          enabled: session ? usesTwoFactor(session.user) : false,
          required: settings.requireTwoFactor,
        }}
      />
      {onboarding ? <SetupChecklist steps={onboarding} /> : null}
      {isAdmin ? (
        <OrganizationSettings
          // Read fresh, not from the short-lived cache, so the form never
          // shows a value that was just replaced.
          initialSettings={toOrganizationSettingsView(
            resolveSettings(await readStoredSettings()),
          )}
        />
      ) : null}
      {googleWorkspace ? (
        <GoogleWorkspacePanel initialView={googleWorkspace} />
      ) : null}
      {sealView ? <SealSettingsSection initialView={sealView} /> : null}
      {backupView ? <BackupSettingsSection initialView={backupView} /> : null}
      {isAdmin ? <TeamsPanel /> : null}
      {isAdmin ? <UpdatesPanel initialStatus={getUpdateStatus(null)} /> : null}
    </div>
  );
}
