import { UploadShell } from "@/components/envelopes/upload-shell";
import { getAuthSession } from "@/lib/auth/server";
import { supportsDirectUploads } from "@/lib/services/storage";
import { buildPendingUploadPrefix } from "@/lib/services/storage-keys";
import { FILES_START_PATH, getFilesStartState } from "@/lib/workspace/files";

export default async function NewEnvelopePage() {
  // The app's layout has already sent anyone signed out to sign in.
  const session = await getAuthSession();
  // Starting from a file in the workspace (Google Drive) is offered once an
  // administrator set it up; otherwise nothing changes here.
  const filesStart = session ? await getFilesStartState(session.user.id) : null;

  // On Vercel Blob the browser sends the PDF straight to storage, into this
  // user's pending folder. With local storage it goes through the app.
  return (
    <UploadShell
      directUploadPrefix={
        session && supportsDirectUploads()
          ? buildPendingUploadPrefix(session.user.id)
          : null
      }
      startFrom={
        filesStart ? (
          // A plain link: the page loads with the policy that lets the
          // provider's picker in (src/proxy.ts).
          <a className="btn-quiet min-h-11 px-4" href={FILES_START_PATH}>
            Start from {filesStart.name}
          </a>
        ) : null
      }
    />
  );
}
