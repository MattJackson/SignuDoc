import type { Metadata } from "next";

import { OrganizationSettings } from "@/components/settings/organization-settings";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { readStoredSettings, resolveSettings } from "@/lib/settings";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Organization" };

export default async function OrganizationSettingsPage() {
  await requireSettingsAdmin();

  return (
    <OrganizationSettings
      // Read fresh, not from the short-lived cache, so the form never shows
      // a value that was just replaced.
      initialSettings={toOrganizationSettingsView(
        resolveSettings(await readStoredSettings()),
      )}
      section="organization"
    />
  );
}
