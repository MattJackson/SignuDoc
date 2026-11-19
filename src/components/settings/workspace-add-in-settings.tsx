import { AddInPanel } from "@/components/settings/add-in-panel";
import { getAddInSettingsView } from "@/lib/workspace/add-in";

// The add-in's part of Settings, for administrators, shown only once a
// workspace provider is chosen for the add-in. With none, this renders
// nothing.

export async function WorkspaceAddInSettings() {
  const view = await getAddInSettingsView().catch((error: unknown) => {
    console.warn(
      "[workspace] The add-in settings could not be read:",
      error instanceof Error ? error.message : error,
    );
    return null;
  });

  return view ? <AddInPanel view={view} /> : null;
}
