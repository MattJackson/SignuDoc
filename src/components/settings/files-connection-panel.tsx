"use client";

import { useState } from "react";

// Settings, for each person: their own connection to their workspace files
// (Google Drive), used to start envelopes from a file. Connecting happens
// at the provider; disconnecting revokes it there too.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function FilesConnectionPanel({
  account,
  connected,
  name,
}: {
  account: string | null;
  connected: boolean;
  /** "Google Drive". */
  name: string;
}) {
  const [isConnected, setIsConnected] = useState(connected);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const connectHref = `/api/workspace/files/connect?returnTo=${encodeURIComponent("/settings#files-connection")}`;

  async function disconnect() {
    setBusy(true);
    setMessage(null);

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
      setBusy(false);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      id="files-connection"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            {name}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            {isConnected
              ? `Connected${account ? ` as ${account}` : ""}. You can start envelopes from files you pick in ${name}; this site can read only those.`
              : `Connect ${name} to start envelopes from your files. This site can read only the files you pick.`}
          </p>
        </div>
        {isConnected ? (
          <button
            className="btn-quiet w-fit"
            disabled={busy}
            onClick={() => void disconnect()}
            type="button"
          >
            {busy ? "Disconnecting..." : `Disconnect ${name}`}
          </button>
        ) : (
          // A route that sends the browser to the provider, so a plain link.
          <a className="btn-quiet w-fit" href={connectHref}>
            Connect {name}
          </a>
        )}
        {message ? (
          <p className="notice notice-accent" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
