"use client";

import { useEffect, useState, type ChangeEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import type { PeopleSettingsView } from "@/lib/people-settings";

// Managers, employees and leavers, in Settings and in onboarding.
// Administrators only. See src/lib/people-settings.ts for what each
// setting does; every one is off until it is turned on here or with its
// environment variable.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type ViewResponse = { error?: string; view?: PeopleSettingsView } | null;

type Draft = {
  directorySync: boolean;
  googleSigning: PeopleSettingsView["googleSigning"]["mode"];
  managerPolicy: PeopleSettingsView["managerPolicy"]["mode"];
  managerPolicyTeamIds: string[];
};

function toDraft(view: PeopleSettingsView): Draft {
  return {
    directorySync: view.directorySync.enabled,
    googleSigning: view.googleSigning.mode,
    managerPolicy: view.managerPolicy.mode,
    managerPolicyTeamIds: view.managerPolicy.teamIds,
  };
}

/** The settings themselves, for Settings and for the onboarding step. */
export function PeopleSettingsForm({ onSaved }: { onSaved?: () => void }) {
  const [view, setView] = useState<PeopleSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/people-settings", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as ViewResponse;

        if (!response.ok || !payload?.view) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setView(payload.view);
        setDraft(toDraft(payload.view));
      })
      .catch((loadError: unknown) => {
        if (!(
          loadError instanceof DOMException && loadError.name === "AbortError"
        )) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, []);

  async function save() {
    if (!view || !draft || saving) {
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/people-settings", {
        body: JSON.stringify({
          ...(view.directorySync.fromEnv
            ? {}
            : { directorySync: draft.directorySync }),
          ...(view.googleSigning.fromEnv
            ? {}
            : { googleSigning: draft.googleSigning }),
          ...(view.managerPolicy.fromEnv
            ? {}
            : { managerPolicy: draft.managerPolicy }),
          managerPolicyTeamIds: draft.managerPolicyTeamIds,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as ViewResponse;

      if (!response.ok || !payload?.view) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setView(payload.view);
      setDraft(toDraft(payload.view));
      setNotice("Saved.");
      onSaved?.();
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  if (!view || !draft) {
    return error ? (
      <div className="notice notice-danger" role="alert">
        {error}
      </div>
    ) : (
      <p className="text-sm text-(--secondary)">Loading...</p>
    );
  }

  const update = (patch: Partial<Draft>) => {
    setNotice(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <div className="space-y-5">
      <fieldset className="well grid gap-3 p-4">
        <legend className="sr-only">The sender&apos;s manager</legend>
        <p className="font-bold text-(--fg)">The sender&apos;s manager</p>
        <p className="text-[0.8125rem] leading-5 text-(--secondary)">
          Senders can add their manager, from the Workspace directory, as an
          approver who approves before anyone else is asked. Choose whether to
          suggest it or require it.
          {view.directory.enabled
            ? ""
            : " This needs the Workspace directory, which is off."}
          {view.part11Mode
            ? " Part 11 mode is on, which has no approvers, so this does not apply while it is."
            : ""}
        </p>
        <select
          aria-label="Manager approval"
          className="field-input"
          disabled={saving || view.managerPolicy.fromEnv}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            update({
              managerPolicy:
                event.target.value === "require" ||
                event.target.value === "suggest"
                  ? event.target.value
                  : "off",
            })
          }
          value={draft.managerPolicy}
        >
          <option value="off">Off</option>
          <option value="suggest">
            Suggest the manager approves in the first step
          </option>
          <option value="require">
            Require the manager to approve in the first step
          </option>
        </select>
        {view.managerPolicy.fromEnv ? (
          <p className="text-xs text-(--tertiary)">
            Set by MANAGER_APPROVAL in the environment.
          </p>
        ) : null}
        {view.teams.length > 0 && draft.managerPolicy !== "off" ? (
          <div className="grid gap-2">
            <p className="text-[0.8125rem] font-semibold text-(--secondary)">
              Only for these teams (none ticked: everyone)
            </p>
            {view.teams.map((team) => (
              <label
                className="flex items-center gap-2 text-sm text-(--fg)"
                key={team.id}
              >
                <input
                  checked={draft.managerPolicyTeamIds.includes(team.id)}
                  className="size-4 shrink-0 cursor-pointer accent-(--accent)"
                  disabled={saving}
                  onChange={(event) =>
                    update({
                      managerPolicyTeamIds: event.target.checked
                        ? [...draft.managerPolicyTeamIds, team.id]
                        : draft.managerPolicyTeamIds.filter(
                            (id) => id !== team.id,
                          ),
                    })
                  }
                  type="checkbox"
                />
                {team.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="well grid gap-3 p-4">
        <legend className="sr-only">Employees sign with Google</legend>
        <p className="font-bold text-(--fg)">Employees sign with Google</p>
        <p className="text-[0.8125rem] leading-5 text-(--secondary)">
          When a signer&apos;s address is in your Workspace domains, the signing
          page can ask them to be signed in here with Google, as that same
          address. It is recorded in the certificate as &ldquo;identity
          confirmed by Google Workspace sign-in&rdquo;. It never replaces an
          access code or emailed code the sender asked for, and people outside
          your organization are never asked.
          {view.googleSigning.available
            ? ` Applies to ${view.googleSigning.domains.join(", ")}.`
            : " This needs Google sign-in and your Workspace domains, which are not both set up yet."}
        </p>
        <select
          aria-label="Employees sign with Google"
          className="field-input"
          disabled={saving || view.googleSigning.fromEnv}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            update({
              googleSigning:
                event.target.value === "require" ||
                event.target.value === "offer"
                  ? event.target.value
                  : "off",
            })
          }
          value={draft.googleSigning}
        >
          <option value="off">Off</option>
          <option value="offer">Offer it to employees</option>
          <option value="require">Require it of employees</option>
        </select>
        {view.googleSigning.fromEnv ? (
          <p className="text-xs text-(--tertiary)">
            Set by GOOGLE_SIGNING in the environment.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="well grid gap-3 p-4">
        <legend className="sr-only">Offboarding</legend>
        <p className="font-bold text-(--fg)">Offboarding</p>
        <p className="text-[0.8125rem] leading-5 text-(--secondary)">
          A scheduled job checks accounts against the Workspace directory.
          Someone suspended or deleted there can no longer sign in here, and
          their open envelopes and drafts go to their manager, or to an
          administrator. The last administrator and the break-glass addresses
          are never touched. The job needs RETENTION_JOB_SECRET; see the Google
          Workspace guide for the schedule.
          {view.directory.enabled
            ? ""
            : " This needs the Workspace directory, which is off."}
        </p>
        <label className="flex items-center gap-2 text-sm text-(--fg)">
          <input
            checked={draft.directorySync}
            className="size-4 shrink-0 cursor-pointer accent-(--accent)"
            disabled={saving || view.directorySync.fromEnv}
            onChange={(event) =>
              update({ directorySync: event.target.checked })
            }
            type="checkbox"
          />
          Offboard people the directory suspended or deleted
        </label>
        {view.directorySync.fromEnv ? (
          <p className="text-xs text-(--tertiary)">
            Set by DIRECTORY_SYNC in the environment.
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      ) : null}
      <ShellButton
        className="w-fit"
        loading={saving}
        onClick={() => void save()}
      >
        {saving ? "Saving..." : "Save"}
      </ShellButton>
    </div>
  );
}

export function PeopleSettingsPanel() {
  return (
    <section
      aria-labelledby="people-settings-heading"
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="people"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2
            className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)"
            id="people-settings-heading"
          >
            Managers, employees and leavers
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Rules that use your Google Workspace: approval by the sender&apos;s
            manager, employees confirming who they are with Google when they
            sign, and handing over a leaver&apos;s envelopes.
          </p>
        </div>
        <PeopleSettingsForm />
      </div>
    </section>
  );
}
