import { SettingsShell } from "@/components/settings/settings-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getSettings } from "@/lib/settings";
import { usesTwoFactor } from "@/lib/sign-in-security";

// Settings, Profile and sign-in: everyone's own account. The administrator's
// pages are beside it in the Settings menu (layout.tsx).
export default async function SettingsPage() {
  const session = await getAuthSession();
  const settings = await getSettings();

  return (
    <SettingsShell
      header={false}
      initialProfile={{
        email: session?.user.email ?? "",
        fullName: session?.user.name ?? "",
      }}
      twoFactor={{
        enabled: session ? usesTwoFactor(session.user) : false,
        required: settings.requireTwoFactor,
      }}
    />
  );
}
