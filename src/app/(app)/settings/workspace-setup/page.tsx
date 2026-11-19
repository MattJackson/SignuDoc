import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { WorkspaceSetupPanel } from "@/components/settings/workspace-setup";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { isHostedMode } from "@/lib/utils/env";
import { getWorkspaceSetupView } from "@/lib/workspace/workspace-setup";

export const metadata: Metadata = { title: "Workspace setup" };

type WorkspaceSetupPageProps = {
  searchParams: Promise<{
    code?: string | string[];
    error?: string | string[];
    provider?: string | string[];
    state?: string | string[];
  }>;
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

// Settings, setting up the workspace provider: step by step, or
// automatically with one sign-in. It is also where the provider sends the
// administrator back to after that sign-in, with a code the page hands to
// /api/admin/workspace/setup/run.
export default async function WorkspaceSetupPage({
  searchParams,
}: WorkspaceSetupPageProps) {
  // The app's layout has already sent anyone signed out to sign in.
  const session = await getAuthSession();

  if (!session || !(await isAdminUser(session.user.id))) {
    redirect("/settings");
  }

  const query = await searchParams;
  const view = await getWorkspaceSetupView(first(query.provider));

  if (!view) {
    redirect("/settings");
  }

  return (
    <WorkspaceSetupPanel
      callback={{
        code: first(query.code),
        error: first(query.error)?.slice(0, 80) ?? null,
        state: first(query.state),
      }}
      // The hosted service sets itself up; only the guide is shown there.
      hosted={isHostedMode()}
      view={view}
    />
  );
}
