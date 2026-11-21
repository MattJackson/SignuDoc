import type { Metadata } from "next";

import { TeamsPanel } from "@/components/settings/teams-panel";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsSettingsPage() {
  await requireSettingsAdmin();

  return <TeamsPanel />;
}
