import type { Metadata } from "next";

import { OrganizationSettings } from "@/components/settings/organization-settings";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { readStoredSettings, resolveSettings } from "@/lib/settings";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "People and security" };

export default async function PeopleSettingsPage() {
  await requireSettingsAdmin({ selfHostedOnly: true });

  return (
    <OrganizationSettings
      initialSettings={toOrganizationSettingsView(
        resolveSettings(await readStoredSettings()),
      )}
      section="people"
    />
  );
}
