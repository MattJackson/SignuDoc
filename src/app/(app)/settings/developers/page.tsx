import type { Metadata } from "next";

import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { EmbeddingPanel } from "@/components/settings/embedding-panel";
import { WebhooksPanel } from "@/components/settings/webhooks-panel";

import { requireSettingsAdmin } from "../require-admin";

export const metadata: Metadata = { title: "API and webhooks" };

// Settings, API and webhooks: keys for other apps to call the API, the
// endpoints that hear about envelopes, and the sites that may show signing
// inside their own pages. The hosted service offers none of them.
export default async function DevelopersSettingsPage() {
  await requireSettingsAdmin({ selfHostedOnly: true });

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      id="developers"
    >
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            API and webhooks
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Let your own apps send envelopes, hear when they change, and show
            signing inside their pages.
          </p>
        </div>

        <ApiKeysPanel />

        <WebhooksPanel />

        <EmbeddingPanel />
      </div>
    </section>
  );
}
