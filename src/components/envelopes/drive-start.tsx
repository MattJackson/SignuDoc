"use client";

import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";

import { Button } from "@/components/ui/button";

// "Choose from Google Drive" on the new-envelope page. The Google Picker
// shows the person's own Drive (and Shared Drives) in a frame from Google;
// the file they pick is turned into a PDF on the server if it is not one
// (a Google Doc, a Word file) and becomes a draft, the same as an upload.
//
// The Picker needs the person's own Drive access token (drive.file, from
// /api/google/drive/picker), this site's browser API key and the Cloud
// project number. Someone who has not connected Google Drive is offered
// "Connect Google Drive" first.
// https://developers.google.com/workspace/drive/picker/guides/overview

const GOOGLE_API_SCRIPT = "https://apis.google.com/js/api.js";
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type PickedDocument = { id: string; mimeType?: string; name?: string };
type PickerResponse = { action: string; docs?: PickedDocument[] };

type DocsView = {
  setEnableDrives(enabled: boolean): DocsView;
  setIncludeFolders(included: boolean): DocsView;
  setMimeTypes(mimeTypes: string): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
};

type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
  enableFeature(feature: unknown): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
};

type PickerNamespace = {
  Action: { CANCEL: string; PICKED: string };
  DocsView: new (viewId?: unknown) => DocsView;
  Feature: { SUPPORT_DRIVES: unknown };
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown };
};

type GoogleWindow = Window & {
  gapi?: {
    load(
      name: string,
      options: { callback: () => void; onerror?: () => void },
    ): void;
  };
  google?: { picker?: PickerNamespace };
};

let pickerLoading: Promise<PickerNamespace> | null = null;

function loadPicker(): Promise<PickerNamespace> {
  const win = window as GoogleWindow;

  if (win.google?.picker) {
    return Promise.resolve(win.google.picker);
  }

  pickerLoading ??= new Promise<PickerNamespace>((resolve, reject) => {
    const whenGapi = () => {
      const gapi = (window as GoogleWindow).gapi;

      if (!gapi) {
        reject(new Error("Google's script did not load."));
        return;
      }

      gapi.load("picker", {
        callback: () => {
          const picker = (window as GoogleWindow).google?.picker;

          if (picker) {
            resolve(picker);
          } else {
            reject(new Error("The Google Picker did not load."));
          }
        },
        onerror: () => reject(new Error("The Google Picker did not load.")),
      });
    };

    if ((window as GoogleWindow).gapi) {
      whenGapi();
      return;
    }

    const script = document.createElement("script");

    script.async = true;
    script.src = GOOGLE_API_SCRIPT;
    script.onload = whenGapi;
    script.onerror = () => reject(new Error("Google's script did not load."));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    pickerLoading = null;
    throw error;
  });

  return pickerLoading;
}

type PickerToken = { accessToken: string; apiKey: string; appId: string };

export function DriveStart({
  connected,
  googleEmail,
  mimeTypes,
  problem,
}: {
  connected: boolean;
  googleEmail: string | null;
  mimeTypes: readonly string[];
  /** Why a Drive step sent the person back here, already in words. */
  problem: string | null;
}) {
  const router = useRouter();
  const [isConnected, setIsConnected] = useState(connected);
  const [busy, setBusy] = useState<"disconnect" | "import" | "picker" | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(problem);
  const connectHref = `/api/google/drive/connect?returnTo=${encodeURIComponent("/envelopes/new")}`;

  async function importFile(fileId: string) {
    setBusy("import");
    setMessage(null);

    try {
      const response = await fetch("/api/google/drive/import", {
        body: JSON.stringify({ fileId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        if (response.status === 409) {
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

    try {
      const response = await fetch("/api/google/drive/picker", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        (Partial<PickerToken> & { connect?: boolean; error?: string }) | null;

      if (
        !response.ok ||
        !payload?.accessToken ||
        !payload.apiKey ||
        !payload.appId
      ) {
        if (payload?.connect) {
          setIsConnected(false);
        }

        setMessage(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      const picker = await loadPicker();
      // My Drive, then Shared Drives.
      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setMimeTypes(mimeTypes.join(","))
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);
      const sharedDrivesView = new picker.DocsView(picker.ViewId.DOCS)
        .setMimeTypes(mimeTypes.join(","))
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setEnableDrives(true);

      new picker.PickerBuilder()
        .addView(view)
        .addView(sharedDrivesView)
        .enableFeature(picker.Feature.SUPPORT_DRIVES)
        .setAppId(payload.appId)
        .setOAuthToken(payload.accessToken)
        .setDeveloperKey(payload.apiKey)
        .setOrigin(window.location.origin)
        .setTitle("Choose a document to send")
        .setCallback((result) => {
          if (result.action === picker.Action.PICKED) {
            const fileId = result.docs?.[0]?.id;

            if (fileId) {
              void importFile(fileId);
            }
          }
        })
        .build()
        .setVisible(true);
    } catch {
      setMessage(
        "The Google Drive picker could not be opened. Check that nothing in this browser blocks Google, and try again.",
      );
    } finally {
      setBusy((current) => (current === "picker" ? null : current));
    }
  }

  async function disconnect() {
    setBusy("disconnect");

    try {
      const response = await fetch("/api/google/drive", { method: "DELETE" });

      if (response.ok) {
        setIsConnected(false);
        setMessage("Google Drive is disconnected.");
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
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {isConnected ? (
          <>
            <Button
              disabled={busy !== null}
              onClick={() => void openPicker()}
              type="button"
              variant="outline"
            >
              {busy === "import"
                ? "Bringing it in..."
                : busy === "picker"
                  ? "Opening Drive..."
                  : "Choose from Google Drive"}
            </Button>
            <button
              className="text-xs font-semibold text-(--secondary) underline underline-offset-4"
              disabled={busy !== null}
              onClick={() => void disconnect()}
              title={googleEmail ? `Connected as ${googleEmail}` : undefined}
              type="button"
            >
              Disconnect Drive
            </button>
          </>
        ) : (
          // A route that sends the browser to Google, so a plain link.
          <a className="btn-quiet min-h-11 px-4" href={connectHref}>
            Connect Google Drive
          </a>
        )}
      </div>
      {message ? (
        <p
          className="max-w-xs text-right text-xs leading-5 text-(--secondary)"
          role="status"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
