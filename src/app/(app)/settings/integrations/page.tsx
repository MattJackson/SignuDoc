import type { Metadata } from "next";

import { IntegrationCard } from "@/components/settings/integration-kit";
import {
  describeStorageBrand,
  INTEGRATIONS,
  type IntegrationInfo,
} from "@/components/settings/integrations-catalog";
import { describeStorageDriver } from "@/lib/storage-check";

import { requireSettingsAdmin } from "../require-admin";
import { getIntegrationStates } from "./statuses";

export const metadata: Metadata = { title: "Integrations" };

const GROUPS: { description: string; name: IntegrationInfo["group"] }[] = [
  {
    description:
      "Sign-in, the directory, Drive and the Gmail add-on, for organizations on Google Workspace.",
    name: "Google Workspace",
  },
  {
    description: "How this site reaches people outside the app.",
    name: "Email and messaging",
  },
  {
    description: "Where documents and their audit trails are kept.",
    name: "Storage",
  },
];

// Settings, Integrations: every service this site connects to, each with
// its status, opening its own page.
export default async function IntegrationsPage() {
  const { settings } = await requireSettingsAdmin();
  const states = await getIntegrationStates();
  const storage = describeStorageBrand(describeStorageDriver().driver);
  // The hosted service runs its own Google, storage and seal.
  const groups = settings.hosted
    ? GROUPS.filter((group) => group.name === "Email and messaging")
    : GROUPS;
  const connected = INTEGRATIONS.filter(
    (integration) => states[integration.id].status === "connected",
  ).length;

  return (
    <section
      className="panel scroll-mt-6 space-y-8 p-6 sm:p-8"
      data-animate="enter"
      id="integrations"
    >
      <div className="space-y-2">
        <p className="section-eyebrow">Administrator</p>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          Integrations
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          The services this site works with. Each one is optional unless it says
          otherwise. {connected} of {INTEGRATIONS.length} are connected.
        </p>
      </div>

      {groups.map((group) => (
        <div
          className="space-y-4 border-t border-(--border) pt-8"
          key={group.name}
        >
          <div className="space-y-1">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              {group.name}
            </h3>
            <p className="text-sm leading-6 text-(--secondary)">
              {group.description}
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {INTEGRATIONS.filter(
              (integration) => integration.group === group.name,
            ).map((integration) => {
              const state = states[integration.id];
              const isStorage = integration.id === "storage";

              return (
                <li key={integration.id}>
                  <IntegrationCard
                    brand={isStorage ? storage.brand : integration.brand}
                    description={integration.description}
                    detail={state.detail}
                    href={integration.href}
                    name={isStorage ? storage.name : integration.name}
                    status={state.status}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
