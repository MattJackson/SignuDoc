import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NotificationPreferencesPanel } from "@/components/settings/notification-preferences-panel";
import { NotificationsAdminPanel } from "@/components/settings/notifications-panel";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import {
  getNotificationPreferencesView,
  getNotificationsAdminView,
} from "@/lib/notifications/settings";

export const metadata: Metadata = {
  title: "Notifications",
};

// Settings, Notifications. Everyone chooses their own direct messages here;
// an administrator also sets up the channels and the rules for who hears
// about what.
export default async function NotificationSettingsPage() {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  const isAdmin = await isAdminUser(session.user.id);
  const [adminView, preferences] = await Promise.all([
    isAdmin ? getNotificationsAdminView() : Promise.resolve(null),
    getNotificationPreferencesView(session.user.id, isAdmin),
  ]);

  return (
    <div className="space-y-8">
      <NotificationPreferencesPanel initialView={preferences} />
      {adminView ? <NotificationsAdminPanel initialView={adminView} /> : null}
    </div>
  );
}
