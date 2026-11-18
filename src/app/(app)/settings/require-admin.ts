import { redirect } from "next/navigation";

import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getSettings } from "@/lib/settings";

/**
 * For the administrator's pages of Settings: someone signed out goes to
 * sign in, and someone who is not an administrator to their own settings.
 * `hosted` pages are not part of the hosted service and send it back too.
 */
export async function requireSettingsAdmin({
  selfHostedOnly = false,
}: { selfHostedOnly?: boolean } = {}) {
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  const [isAdmin, settings] = await Promise.all([
    isAdminUser(session.user.id),
    getSettings(),
  ]);

  if (!isAdmin || (selfHostedOnly && settings.hosted)) {
    redirect("/settings");
  }

  return { session, settings };
}
