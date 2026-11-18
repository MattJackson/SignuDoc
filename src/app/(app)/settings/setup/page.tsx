import type { Metadata } from "next";

import { SetupChecklist } from "@/components/settings/setup-checklist";
import { getOnboardingState } from "@/lib/onboarding/steps";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "Setup checklist" };

export default async function SetupChecklistPage() {
  await requireSettingsAdmin({ selfHostedOnly: true });

  return <SetupChecklist steps={await getOnboardingState()} />;
}
