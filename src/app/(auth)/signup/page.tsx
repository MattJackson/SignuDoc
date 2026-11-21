import { SignupShell } from "@/components/auth/signup-shell";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { getSignInConfig } from "@/lib/auth/sign-in-settings";
import { buildBranding } from "@/lib/branding";
import { canSendEmail } from "@/lib/services/email";
import { getSettings } from "@/lib/settings";
import { describeSignupPolicy } from "@/lib/signup-policy";

export default async function SignupPage() {
  await redirectIfSignedIn();

  const settings = await getSettings();
  const { passwordPolicy, sso } = await getSignInConfig();

  return (
    <SignupShell
      emailConnected={canSendEmail()}
      passwordSignIn={passwordPolicy.enabled}
      sso={sso ? { google: sso.google, name: sso.name } : null}
      signupAvailable={buildBranding(settings).signupAvailable}
      // Says who can sign up before anyone fills the form in. Nothing to
      // say when anyone can.
      signupRule={
        settings.signupMode === "open" ? null : describeSignupPolicy(settings)
      }
    />
  );
}
