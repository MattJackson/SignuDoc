"use client";

import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";

import { pickGoogleDriveFile } from "@/components/envelopes/google-picker";
import { ShellButton } from "@/components/shared/form-shell";
import type { FilesPickerConfig } from "@/lib/workspace/types";

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

// Starting an envelope from a file in the workspace: connect once, then
// pick a file in the provider's own picker (for Google, the Google Picker,
// which shows the person's Drive and Shared Drives in a frame from
// Google). The file is made into a PDF on the server if it is not one (a
// Google Doc, a Word file) and becomes a draft, the same as an upload.
// https://developers.google.com/workspace/drive/picker/guides/overview

type PickerReply = Partial<FilesPickerConfig> & {
  connect?: boolean;
  error?: string;
};

/** Shows the provider's own picker, chosen by the config's tag. */
function pickFile(config: FilesPickerConfig): Promise<string | null> {
  switch (config.provider) {
    case "google":
      return pickGoogleDriveFile(config);
  }
}

export function FilesStart({
  account,
  connected,
  name,
  problem,
}: {
  /** The person's account at the provider, when connected. */
  account: string | null;
  connected: boolean;
  /** "Google Drive". */
  name: string;
  /** Why connecting sent the person back here, already in words. */
  problem: string | null;
}) {
  const router = useRouter();
  const [isConnected, setIsConnected] = useState(connected);
  const [busy, setBusy] = useState<"import" | "picker" | null>(null);
  const [message, setMessage] = useState<string | null>(problem);
  const connectHref = `/api/workspace/files/connect?returnTo=${encodeURIComponent("/envelopes/new/files")}`;

  async function importFile(fileId: string) {
    setBusy("import");
    setMessage(null);

    try {
      const response = await fetch("/api/workspace/files/import", {
        body: JSON.stringify({ fileId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        connect?: boolean;
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        if (payload?.connect) {
          setIsConnected(false);
        }

        setMessage(payload?.error ?? GENERIC_ERROR_MESSAGE);
        setBusy(null);
        return;
      }

      const redirectPath = payload.redirectPath;

      startTransition(() => {
        router.push(redirectPath);
      });
    } catch {
      setMessage(GENERIC_ERROR_MESSAGE);
      setBusy(null);
    }
  }

  async function openPicker() {
    setBusy("picker");
    setMessage(null);

    let fileId: string | null = null;

    try {
      const response = await fetch("/api/workspace/files/picker", {
        cache: "no-store",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as PickerReply | null;

      if (!response.ok || !payload?.provider || !payload.accessToken) {
        if (payload?.connect) {
          setIsConnected(false);
        }

        setMessage(payload?.error ?? GENERIC_ERROR_MESSAGE);
        setBusy(null);
        return;
      }

      fileId = await pickFile(payload as FilesPickerConfig);
    } catch {
      setMessage(
        `The ${name} picker could not be opened. Check that nothing in this browser blocks it, and try again.`,
      );
    }

    if (fileId) {
      await importFile(fileId);
    } else {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("import");

    try {
      const response = await fetch("/api/workspace/files", {
        method: "DELETE",
      });

      if (response.ok) {
        setIsConnected(false);
        setMessage(`${name} is disconnected.`);
      } else {
        setMessage(GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {isConnected ? (
        <div className="flex flex-wrap items-center gap-3">
          <ShellButton
            disabled={busy !== null}
            loading={busy !== null}
            onClick={() => void openPicker()}
          >
            {busy === "import"
              ? "Bringing it in..."
              : busy === "picker"
                ? `Opening ${name}...`
                : `Choose from ${name}`}
          </ShellButton>
          <button
            className="text-sm font-semibold text-(--secondary) underline underline-offset-4"
            disabled={busy !== null}
            onClick={() => void disconnect()}
            type="button"
          >
            Disconnect {name}
          </button>
        </div>
      ) : (
        // A route that sends the browser to the provider, so a plain link.
        <a className="btn-quiet min-h-11 w-fit px-4" href={connectHref}>
          Connect {name}
        </a>
      )}
      {isConnected && account ? (
        <p className="text-sm leading-6 text-(--secondary)">
          Connected as {account}. Only the files you pick here can be read.
        </p>
      ) : null}
      {message ? (
        <p className="notice notice-accent" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
