import Link from "next/link";
import { redirect } from "next/navigation";

import { FilesStart } from "@/components/envelopes/files-start";
import { PageHeader } from "@/components/shared/page-header";
import { getAuthSession } from "@/lib/auth/server";
import {
  describeFilesProblem,
  getFilesStartState,
} from "@/lib/workspace/files";

// Starting an envelope from a file in the workspace (Google Drive). It has
// its own page because the provider's picker loads the provider's script
// and frames, which only this page allows (src/proxy.ts). Links here are
// plain links, so the page always loads with its own policy.

type FilesStartPageProps = {
  searchParams: Promise<{ files?: string | string[] }>;
};

export default async function FilesStartPage({
  searchParams,
}: FilesStartPageProps) {
  // The app's layout has already sent anyone signed out to sign in.
  const session = await getAuthSession();
  const state = session ? await getFilesStartState(session.user.id) : null;

  if (!state) {
    redirect("/envelopes/new");
  }

  const { files } = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          <Link className="btn-quiet min-h-11 px-4" href="/envelopes/new">
            Upload a file instead
          </Link>
        }
        description={`Step 1 of 4 - Choose a document from ${state.name}`}
        title="New envelope"
      />
      <section className="panel space-y-4 p-6 sm:p-8" data-animate="enter">
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Pick a PDF, or a document that can be made into one, such as a text
          document, a spreadsheet or a presentation. It becomes a draft, the
          same as an upload.
        </p>
        <FilesStart
          account={state.account}
          connected={state.connected}
          name={state.name}
          problem={describeFilesProblem(
            Array.isArray(files) ? files[0] : files,
          )}
        />
      </section>
    </div>
  );
}
