import { FilesConnectionPanel } from "@/components/settings/files-connection-panel";
import { SharedFolderPanel } from "@/components/settings/shared-folder-panel";
import {
  getFilesProviderChoice,
  getWorkspaceFilesSettingsView,
} from "@/lib/workspace/export-settings";
import { getFilesStartState } from "@/lib/workspace/files";

// The files parts of Settings, shown only once a workspace provider is
// chosen for files: each person's own connection, when people can start
// envelopes from their files, and for administrators where copies of
// completed envelopes go. With no provider this renders nothing.

export async function WorkspaceFilesSettings({
  isAdmin,
  userId,
}: {
  isAdmin: boolean;
  userId: string | null;
}) {
  const found = await getFilesProviderChoice().catch(() => null);

  if (!found) {
    return null;
  }

  const [start, view] = await Promise.all([
    userId ? getFilesStartState(userId) : null,
    isAdmin
      ? getWorkspaceFilesSettingsView(found.choice, found.files).catch(
          (error: unknown) => {
            console.warn(
              "[workspace] The files settings could not be read:",
              error instanceof Error ? error.message : error,
            );
            return null;
          },
        )
      : null,
  ]);

  return (
    <>
      {start ? (
        <FilesConnectionPanel
          account={start.account}
          connected={start.connected}
          name={start.name}
        />
      ) : null}
      {view ? <SharedFolderPanel initialView={view} /> : null}
    </>
  );
}
