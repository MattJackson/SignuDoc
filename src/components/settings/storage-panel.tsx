"use client";

import { useState } from "react";

import {
  ActionRow,
  EnvLockedNotice,
  IntegrationPanel,
  TestResult,
  type BrandId,
  type ConnectionStatus,
} from "@/components/settings/integration-kit";
import { ShellButton } from "@/components/shared/form-shell";

// Settings, Integrations, Document storage, and the onboarding step of the
// same name. Where documents are kept is chosen when the site is deployed
// (STORAGE_DRIVER and its credentials), so it is shown here and checked,
// not changed.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export type StorageInfo = { driver: string | null; problem: string | null };

const DRIVER_NAMES: Record<string, string> = {
  blob: "Vercel Blob",
  gcs: "Google Cloud Storage",
  local: "the server's own disk",
};

export function StoragePanel({
  brand,
  detail,
  name,
  status,
  storage,
}: {
  brand: BrandId;
  detail: string;
  name: string;
  status: ConnectionStatus;
  storage: StorageInfo;
}) {
  return (
    <IntegrationPanel
      brand={brand}
      description="Where signed documents, their audit trails and uploads are kept."
      detail={detail}
      id="storage"
      name={name}
      status={status}
    >
      <StorageCheckSection storage={storage} />
    </IntegrationPanel>
  );
}

/** What storage this site uses, and a button that proves it works. */
export function StorageCheckSection({ storage }: { storage: StorageInfo }) {
  const [result, setResult] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    setResult(null);

    try {
      const response = await fetch("/api/admin/onboarding", {
        body: JSON.stringify({ action: "check_storage" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        storage?: { driver: string | null; message?: string; ok: boolean };
      } | null;

      setResult(
        payload?.storage?.ok
          ? {
              message: `It works. A test file was written to ${DRIVER_NAMES[payload.storage.driver ?? ""] ?? "storage"}, read back and deleted.`,
              ok: true,
            }
          : {
              message:
                payload?.storage?.message ??
                payload?.error ??
                GENERIC_ERROR_MESSAGE,
              ok: false,
            },
      );
    } catch {
      setResult({ message: GENERIC_ERROR_MESSAGE, ok: false });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
        {storage.driver
          ? `Documents are kept in ${DRIVER_NAMES[storage.driver] ?? storage.driver}.`
          : `Storage is not set up: ${storage.problem ?? "unknown driver"}.`}{" "}
        To move them elsewhere, see the self-hosting guide.
      </p>
      <EnvLockedNotice variables={["STORAGE_DRIVER"]}>
        <p>Its credentials are set the same way, beside it.</p>
      </EnvLockedNotice>
      <ActionRow>
        <ShellButton
          loading={checking}
          onClick={() => void check()}
          variant="secondary"
        >
          {checking ? "Checking..." : "Test read and write"}
        </ShellButton>
      </ActionRow>
      <TestResult result={result} />
    </div>
  );
}
