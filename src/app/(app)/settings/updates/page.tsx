import type { Metadata } from "next";

import { UpdatesPanel } from "@/components/settings/updates-panel";
import { getUpdateStatus } from "@/lib/software-update";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "SignuDoc version" };

export default async function UpdatesSettingsPage() {
  await requireSettingsAdmin();

  return <UpdatesPanel initialStatus={getUpdateStatus(null)} />;
}
