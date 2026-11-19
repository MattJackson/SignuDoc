import type { Metadata } from "next";

import { PeopleSettingsPanel } from "@/components/settings/people-settings-panel";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Managers and leavers" };

export default async function ManagersSettingsPage() {
  await requireSettingsAdmin({ selfHostedOnly: true });

  return <PeopleSettingsPanel />;
}
