"use client";

import { useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import type { PreferenceChoice } from "@/lib/notifications/preferences";
import type { NotificationPreferencesView } from "@/lib/notifications/settings";

// Settings, Notifications, for everyone: which events send you a direct
// message, about the envelopes you send and, if you are on a team, about
// your teammates'. Slack finds you by your email address here.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type Feedback = { message: string; tone: "error" | "success" } | null;

function choiceKey(choice: Pick<PreferenceChoice, "event" | "scope">) {
  return `${choice.event}:${choice.scope}`;
}

export function NotificationPreferencesPanel({
  initialView,
}: {
  initialView: NotificationPreferencesView;
}) {
  const [view, setView] = useState(initialView);
  const channel = view.channels.find((item) => item.id === "slack") ?? null;
  const [choices, setChoices] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (channel?.choices ?? []).map((choice) => [
        choiceKey(choice),
        choice.enabled,
      ]),
    ),
  );
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (!channel) {
    return null;
  }

  const available = new Set(channel.choices.map(choiceKey));
  const rows = view.events.filter(
    (event) =>
      available.has(choiceKey({ event: event.kind, scope: "own" })) ||
      available.has(choiceKey({ event: event.kind, scope: "team" })),
  );

  async function save() {
    if (!channel) {
      return;
    }

    setPending("save");
    setFeedback(null);

    try {
      const response = await fetch("/api/account/notifications", {
        body: JSON.stringify({
          channel: channel.id,
          preferences: channel.choices.map((choice) => ({
            enabled: choices[choiceKey(choice)] ?? choice.enabled,
            event: choice.event,
            scope: choice.scope,
          })),
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        view?: NotificationPreferencesView;
      } | null;

      if (!response.ok || !payload?.view) {
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setView(payload.view);
      setFeedback({ message: "Saved.", tone: "success" });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPending(null);
    }
  }

  async function test() {
    setPending("test");
    setFeedback(null);

    try {
      const response = await fetch("/api/account/notifications", {
        body: JSON.stringify({ action: "test_slack_message" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        result?: { message: string; ok: boolean };
      } | null;

      if (!payload?.result) {
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setFeedback({
        message: payload.result.message,
        tone: payload.result.ok ? "success" : "error",
      });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPending(null);
    }
  }

  function checkbox(event: PreferenceChoice["event"], scope: "own" | "team") {
    const key = choiceKey({ event, scope });

    if (!available.has(key)) {
      return <span className="text-(--secondary)">-</span>;
    }

    return (
      <input
        aria-label={`${event} ${scope === "own" ? "for my envelopes" : "for my teams' envelopes"}`}
        checked={choices[key] ?? false}
        className="size-4 accent-(--accent)"
        disabled={pending !== null}
        onChange={(change) => {
          const checked = change.target.checked;

          setChoices((current) => ({ ...current, [key]: checked }));
          setFeedback(null);
        }}
        type="checkbox"
      />
    );
  }

  return (
    <section
      className="panel scroll-mt-6 space-y-6 p-6 sm:p-8"
      data-animate="enter"
      id="my-notifications"
    >
      <div className="space-y-2">
        <p className="section-eyebrow">Your account</p>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          My notifications
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Choose what {channel.name} sends you a direct message about. It finds
          you by the email address of this account, so your {channel.name}{" "}
          account needs the same one. Messages name the document and who did
          what, and link here; they never include the document itself.
        </p>
      </div>

      {channel.available ? null : (
        <p className="notice notice-warning">
          Direct messages from {channel.name} are not set up on this site yet.
          Your choices are kept for when they are.
        </p>
      )}

      {feedback ? (
        <p
          className={`notice ${feedback.tone === "success" ? "notice-success" : "notice-danger"}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead>
            <tr className="border-b border-(--border) text-(--secondary)">
              <th className="py-2 pr-4 font-semibold">Event</th>
              <th className="py-2 pr-4 font-semibold">My envelopes</th>
              {view.onTeam ? (
                <th className="py-2 pr-4 font-semibold">
                  My teams&apos; envelopes
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr className="border-b border-(--border)" key={event.kind}>
                <td className="py-3 pr-4">
                  <span className="block font-semibold text-(--fg)">
                    {event.label}
                  </span>
                  <span className="block text-(--secondary)">
                    {event.description}
                    {event.audience === "admin" ? " (administrators)" : ""}
                  </span>
                </td>
                <td className="py-3 pr-4">{checkbox(event.kind, "own")}</td>
                {view.onTeam ? (
                  <td className="py-3 pr-4">{checkbox(event.kind, "team")}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3">
        <ShellButton loading={pending === "save"} onClick={() => void save()}>
          {pending === "save" ? "Saving..." : "Save"}
        </ShellButton>
        {channel.available ? (
          <ShellButton
            loading={pending === "test"}
            onClick={() => void test()}
            variant="secondary"
          >
            {pending === "test" ? "Sending..." : "Send me a test message"}
          </ShellButton>
        ) : null}
      </div>
    </section>
  );
}
