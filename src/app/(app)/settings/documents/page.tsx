import type { Metadata } from "next";

import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SealSettingsSection } from "@/components/settings/seal-settings-section";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { getSealSettingsView } from "@/lib/seal-setup";
import { readStoredSettings, resolveSettings } from "@/lib/settings";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Seal and records" };

// Documents and seal: how finished documents are sealed and timestamped,
// Part 11 mode, and signer data requests.
export default async function DocumentsSettingsPage() {
  const { settings } = await requireSettingsAdmin();
  // The hosted service seals with its operator's certificate.
  const sealView = settings.hosted ? null : await getSealSettingsView();

  return (
    <>
      {sealView ? <SealSettingsSection initialView={sealView} /> : null}
      <OrganizationSettings
        initialSettings={toOrganizationSettingsView(
          resolveSettings(await readStoredSettings()),
        )}
        section="documents"
      />
    </>
  );
}
