import type { Metadata } from "next";

import { BackupSettingsSection } from "@/components/settings/backup-settings-section";
import { getBackupSettingsView } from "@/lib/backup-config";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Backups" };

export default async function BackupsSettingsPage() {
  await requireSettingsAdmin();

  return <BackupSettingsSection initialView={await getBackupSettingsView()} />;
}
