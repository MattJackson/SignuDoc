import { DriveStart } from "@/components/envelopes/drive-start";
import { UploadShell } from "@/components/envelopes/upload-shell";
import { getAuthSession } from "@/lib/auth/server";
import { describeDriveProblem } from "@/lib/drive-problems";
import { getDrivePickerState, PICKER_MIME_TYPES } from "@/lib/google-drive";
import { supportsDirectUploads } from "@/lib/services/storage";
import { buildPendingUploadPrefix } from "@/lib/services/storage-keys";

type NewEnvelopePageProps = {
  searchParams: Promise<{ drive?: string | string[] }>;
};

export default async function NewEnvelopePage({
  searchParams,
}: NewEnvelopePageProps) {
  // The app's layout has already sent anyone signed out to sign in.
  const session = await getAuthSession();
  const { drive } = await searchParams;
  const problem = describeDriveProblem(Array.isArray(drive) ? drive[0] : drive);
  // Google Drive is offered once an administrator set up the Picker
  // (Settings, Google Workspace, Google Drive).
  const pickerState = session
    ? await getDrivePickerState(session.user.id)
    : null;

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
        pickerState?.available ? (
          <DriveStart
            connected={pickerState.connected}
            googleEmail={pickerState.googleEmail}
            mimeTypes={PICKER_MIME_TYPES}
            problem={problem}
          />
        ) : problem ? (
          // Drive's "Open with" works without the Picker, and can send
          // someone back here with a problem.
          <p
            className="max-w-xs text-xs leading-5 text-(--secondary)"
            role="status"
          >
            {problem}
          </p>
        ) : null
      }
    />
  );
}
