import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/settings/settings-nav";
import { PageHeader } from "@/components/shared/page-header";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Settings",
};

// Settings: the page's title, the list of its pages down the side, and the
// page that is open beside it.
export default async function SettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  const [isAdmin, settings] = await Promise.all([
    isAdminUser(session.user.id),
    getSettings(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        description={
          isAdmin
            ? "Your own account, and how this site works for everyone in your organization."
            : "Manage your sender profile, password, two-step sign-in and notifications."
        }
        title="Settings"
      />
      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <SettingsNav hosted={settings.hosted} isAdmin={isAdmin} />
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}
