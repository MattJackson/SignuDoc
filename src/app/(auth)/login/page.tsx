import { LoginShell } from "@/components/auth/login-shell";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { getSignInConfig } from "@/lib/auth/sign-in-settings";
import { safeReturnPath } from "@/lib/return-path";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    next?: string;
    token?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  // Where to go once signed in, when another page sent the visitor here
  // (Google Drive's "Open with", say). Only a path on this site.
  const returnTo = safeReturnPath(resolvedSearchParams?.next, "/dashboard");

  // A link from a password reset email is for this page whoever is signed
  // in, so it is shown as it is.
  if (!resolvedSearchParams?.token && !resolvedSearchParams?.error) {
    await redirectIfSignedIn(returnTo);
  }

  const error = resolvedSearchParams?.error ?? null;
  const { passwordPolicy, sso } = await getSignInConfig();

  return (
    <LoginShell
      passwordSignIn={
        passwordPolicy.enabled
          ? "on"
          : passwordPolicy.allowedEmails.length > 0
            ? "fallback"
            : "off"
      }
      resetError={error === "INVALID_TOKEN" ? error : null}
      resetToken={resolvedSearchParams?.token ?? null}
      returnTo={returnTo}
      sso={sso ? { google: sso.google, name: sso.name } : null}
      // Anything else is single sign-on coming back without a session.
      ssoError={error && error !== "INVALID_TOKEN" ? error.slice(0, 80) : null}
    />
  );
}
