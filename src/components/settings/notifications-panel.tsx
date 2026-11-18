"use client";

import { MessagesSquareIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import {
  BrandMark,
  CopyButton,
  EnvLockedNotice,
  Notice as KitNotice,
  SetupStep,
  StatusBadge,
} from "@/components/settings/integration-kit";
import {
  draftFromRule,
  EMPTY_RULE,
  ruleBody,
  type RuleDraft,
} from "@/components/settings/notification-rule-draft";
import { parseDays } from "@/components/settings/notification-thresholds";
import { SlackMessagePreview } from "@/components/settings/slack-message-preview";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { NotificationEventKind } from "@/lib/notifications/events";
import type { NotificationRule } from "@/lib/notifications/rules";
import type { NotificationsAdminView } from "@/lib/notifications/settings";

// Settings, Notifications, for administrators: the channels notifications
// can go to (Slack now, others listed as coming later), Slack's setup step
// by step with this site's own app manifest, the rules for which events
// go to which channel, and how the job judges "expiring soon" and "no
// activity". See docs/notifications.md.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const SLACK_NEW_APP_URL = "https://api.slack.com/apps?new_app=1";
// The app icon to upload to Slack; also the picture in the previews.
const SLACK_ICON_URL = "/api/admin/notifications/slack-icon";

type Feedback = { message: string; tone: "error" | "success" } | null;

type CheckResult = { message: string; ok: boolean };

type SlackChannelOption = {
  id: string;
  isMember: boolean;
  name: string;
};

async function send<T>(
  path: string,
  method: "DELETE" | "POST" | "PUT",
  body?: unknown,
): Promise<{
  error: string | null;
  fieldErrors: Record<string, string>;
  payload: T | null;
}> {
  try {
    const response = await fetch(path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      method,
    });
    const payload = (await response.json().catch(() => null)) as
      (T & { error?: string; fieldErrors?: Record<string, string> }) | null;

    if (!response.ok) {
      return {
        error: payload?.error ?? GENERIC_ERROR_MESSAGE,
        fieldErrors: payload?.fieldErrors ?? {},
        payload: null,
      };
    }

    return { error: null, fieldErrors: {}, payload };
  } catch {
    return { error: GENERIC_ERROR_MESSAGE, fieldErrors: {}, payload: null };
  }
}

function Notice({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }

  return <KitNotice tone={feedback.tone}>{feedback.message}</KitNotice>;
}

function StatusPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "neutral" | "success" | "warning";
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function Step({
  children,
  done,
  title,
}: {
  children: ReactNode;
  done: boolean | null;
  title: string;
}) {
  return (
    <SetupStep ok={done} title={title}>
      {children}
    </SetupStep>
  );
}

export function NotificationsAdminPanel({
  initialView,
}: {
  initialView: NotificationsAdminView;
}) {
  const [view, setView] = useState(initialView);

  return (
    <section
      className="panel scroll-mt-6 space-y-8 p-6 sm:p-8"
      data-animate="enter"
      id="notification-channels"
    >
      <div className="space-y-2">
        <p className="section-eyebrow">Administrator</p>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          Notification channels
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Tell people in your chat tool when envelopes are signed, completed,
          declined or stuck, and tell administrators when a backup fails.
          Messages name the document, say what happened and who did it, and link
          back here; they never carry the document. Nothing is sent until a
          channel is set up. The full guide is in docs/notifications.md.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        <li className="flex items-start gap-4 rounded-2xl bg-(--surface) px-5 py-4">
          <BrandMark brand="slack" size="sm" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <a
                className="text-sm font-bold text-(--fg) hover:underline"
                href="#slack"
              >
                Slack
              </a>
              <StatusBadge
                status={view.slack.configured ? "connected" : "not_set_up"}
              />
            </div>
            <p className="text-sm leading-6 text-(--secondary)">
              Direct messages to the people involved, and posts in the channels
              you choose.
            </p>
          </div>
        </li>
        {view.planned.map((channel) => (
          <li
            className="flex items-start gap-4 rounded-2xl border border-dashed border-(--border-strong) px-5 py-4"
            key={channel.id}
          >
            <BrandMark icon={MessagesSquareIcon} size="sm" />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold text-(--fg)">
                  {channel.name}
                </span>
                <StatusPill tone="neutral">Coming later</StatusPill>
              </div>
              <p className="text-sm leading-6 text-(--secondary)">
                {channel.description}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <SlackSetup onView={setView} view={view} />
      <MessagePreviews view={view} />
      <RulesSection onView={setView} view={view} />
      <ThresholdsSection onView={setView} view={view} />
      <DeliveryStatus view={view} />
    </section>
  );
}

type SectionProps = {
  onView: (view: NotificationsAdminView) => void;
  view: NotificationsAdminView;
};

function SlackSetup({ onView, view }: SectionProps) {
  const { slack } = view;
  const locked = slack.source === "env";
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [connection, setConnection] = useState<CheckResult | null>(null);

  async function save(
    fields: Record<string, unknown>,
    action: string,
    done: string,
  ) {
    setPending(action);
    setFeedback(null);

    const result = await send<{ view: NotificationsAdminView }>(
      "/api/admin/notifications",
      "PUT",
      fields,
    );

    setPending(null);
    setTokenError(result.fieldErrors.slackBotToken);

    if (!result.payload?.view) {
      setFeedback({
        message: result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
      return;
    }

    onView(result.payload.view);
    setToken("");
    setConnection(null);
    setFeedback({ message: done, tone: "success" });
  }

  async function check(body: Record<string, unknown>, action: string) {
    setPending(action);
    setFeedback(null);

    const result = await send<{ result: CheckResult }>(
      "/api/admin/notifications",
      "POST",
      body,
    );

    setPending(null);

    const outcome = result.payload?.result ?? {
      message: result.error ?? GENERIC_ERROR_MESSAGE,
      ok: false,
    };

    if (action === "connection") {
      setConnection(outcome);
    } else {
      setFeedback({
        message: outcome.message,
        tone: outcome.ok ? "success" : "error",
      });
    }
  }

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(
      { slackBotToken: token },
      "token",
      "Saved. Now test the connection.",
    );
  }

  return (
    <div
      className="scroll-mt-6 space-y-5 border-t border-(--border) pt-8"
      id="slack"
    >
      <div className="flex flex-wrap items-center gap-3">
        <BrandMark brand="slack" size="sm" />
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Slack
        </h3>
        <StatusBadge status={slack.configured ? "connected" : "not_set_up"} />
      </div>

      <Notice feedback={feedback} />

      <ol className="space-y-3">
        <Step done={slack.configured} title="1. Create the Slack app">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open{" "}
              <a
                className="font-semibold text-(--accent-ink) underline underline-offset-4"
                href={SLACK_NEW_APP_URL}
                rel="noreferrer"
                target="_blank"
              >
                Slack&apos;s app page
              </a>
              , choose <strong>From a manifest</strong>, and pick your
              workspace.
            </li>
            <li>Paste this manifest (JSON) and create the app.</li>
          </ol>
          <div className="space-y-2">
            <pre className="max-h-72 overflow-auto rounded-xl bg-white p-3 font-mono text-[0.75rem] text-(--fg)">
              {slack.manifest}
            </pre>
            <CopyButton label="app manifest" value={slack.manifest} />
          </div>
          <div className="space-y-1">
            <a
              className="font-semibold text-(--accent-ink) underline underline-offset-4"
              download="slack-app-icon.png"
              href={`${SLACK_ICON_URL}?download=1`}
            >
              Download app icon (512×512)
            </a>
            <p>
              In Slack, open your app&apos;s Basic Information page, then
              Display Information, and upload this icon.
            </p>
          </div>
          <p>
            It asks for only what notifications need:{" "}
            {slack.scopes.map((scope, index) => (
              <span key={scope}>
                {index > 0 ? ", " : ""}
                <code>{scope}</code>
              </span>
            ))}
            . <code>chat:write</code> posts the messages;{" "}
            <code>users:read</code> and <code>users:read.email</code> find each
            person by their email address for direct messages; and{" "}
            <code>channels:read</code> lists public channels to pick from below.
            The app cannot read messages, and posts only where it is invited.
          </p>
        </Step>

        <Step
          done={slack.configured}
          title="2. Install it and paste the bot token"
        >
          <p>
            In the app&apos;s settings, open <strong>Install App</strong>,
            install it to your workspace, and copy the{" "}
            <strong>Bot User OAuth Token</strong> (it starts with{" "}
            <code>xoxb-</code>).
          </p>
          {locked ? (
            <EnvLockedNotice variables={["SLACK_BOT_TOKEN"]} />
          ) : (
            <form className="space-y-4" noValidate onSubmit={saveToken}>
              <div className="max-w-md">
                <FieldShell
                  autoComplete="off"
                  disabled={pending !== null}
                  error={tokenError}
                  helper={
                    slack.source === "settings"
                      ? "A token is saved, encrypted. Paste a new one to replace it."
                      : "Stored encrypted, and never shown again."
                  }
                  ignorePasswordManagers
                  label="Bot User OAuth Token"
                  name="slack-bot-token"
                  onChange={(event) => {
                    setToken(event.target.value);
                    setTokenError(undefined);
                  }}
                  placeholder="xoxb-..."
                  readOnly={false}
                  type="password"
                  value={token}
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <ShellButton
                  disabled={!token.trim()}
                  loading={pending === "token"}
                  type="submit"
                >
                  {pending === "token" ? "Saving..." : "Save token"}
                </ShellButton>
                {slack.source === "settings" ? (
                  <ShellButton
                    disabled={pending !== null}
                    onClick={() =>
                      void save(
                        { removeSlackBotToken: true },
                        "remove",
                        "The token was removed. Nothing more is sent to Slack.",
                      )
                    }
                    variant="ghost"
                  >
                    Remove token
                  </ShellButton>
                ) : null}
              </div>
            </form>
          )}
        </Step>

        <Step
          done={connection ? connection.ok : null}
          title="3. Test the connection"
        >
          <p>Asks Slack which workspace the token belongs to.</p>
          <ShellButton
            disabled={!slack.configured}
            loading={pending === "connection"}
            onClick={() => void check({ action: "test_slack" }, "connection")}
            variant="secondary"
          >
            {pending === "connection" ? "Testing..." : "Test connection"}
          </ShellButton>
          {connection ? (
            <p
              className={`notice ${connection.ok ? "notice-success" : "notice-danger"}`}
              role={connection.ok ? "status" : "alert"}
            >
              {connection.message}
            </p>
          ) : null}
        </Step>

        <Step done={null} title="4. Direct messages">
          <p>
            The sender of an envelope gets a direct message when it is signed,
            completed, declined, expired, close to its deadline or idle, and
            administrators when a backup fails. Each person can change what they
            get under My notifications above, and can also follow their
            teammates&apos; envelopes. Slack finds people by email address, so
            it only reaches those whose Slack account has the same address.
          </p>
          <label className="flex items-center gap-3 font-semibold text-(--fg)">
            <input
              checked={slack.directMessages}
              className="size-4 accent-(--accent)"
              disabled={!slack.configured || pending !== null}
              onChange={(event) =>
                void save(
                  { directMessages: event.target.checked },
                  "dm",
                  event.target.checked
                    ? "Direct messages are on."
                    : "Direct messages are off. Channel rules still post.",
                )
              }
              type="checkbox"
            />
            Send direct messages
          </label>
          <ShellButton
            disabled={!slack.configured}
            loading={pending === "test-me"}
            onClick={() =>
              void check({ action: "test_slack_message" }, "test-me")
            }
            variant="secondary"
          >
            {pending === "test-me" ? "Sending..." : "Send me a test message"}
          </ShellButton>
        </Step>

        <Step
          done={view.rules.length > 0 ? true : null}
          title="5. Invite the app to channels"
        >
          <p>
            For a channel to receive posts, open it in Slack and type{" "}
            <code>/invite @</code> followed by the app&apos;s name. Then add a
            rule for it below. For a private channel, invite the app and paste
            the channel&apos;s ID (at the bottom of the channel&apos;s details).
          </p>
        </Step>
      </ol>
    </div>
  );
}

function MessagePreviews({ view }: { view: NotificationsAdminView }) {
  const { previews } = view.slack;
  const [kind, setKind] = useState(previews[0]?.kind ?? null);
  const preview = previews.find((item) => item.kind === kind) ?? previews[0];

  if (!preview) {
    return null;
  }

  return (
    <div
      className="space-y-5 border-t border-(--border) pt-8"
      id="slack-previews"
    >
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          What the messages look like
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Each envelope gets one message per channel. The first post starts a
          thread, later events reply in it, and the first post is updated to
          show where things stand. In direct messages, progress updates one
          message; a new one arrives when something needs the sender. Signatures
          wait a minute, so several in a row become one message.
        </p>
      </div>

      <div aria-label="Message type" className="segmented" role="group">
        {previews.map((item) => (
          <button
            aria-pressed={item.kind === preview.kind}
            className="segmented-item"
            key={item.kind}
            onClick={() => setKind(item.kind)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="well space-y-3 p-4">
        <SlackMessagePreview
          appName={view.slack.appName}
          content={preview.message}
          iconUrl={SLACK_ICON_URL}
        />
        {preview.reply ? (
          <>
            <p className="px-1 text-xs font-semibold text-(--secondary)">
              As a reply in a channel&apos;s thread
            </p>
            <SlackMessagePreview
              appName={view.slack.appName}
              content={preview.reply}
              iconUrl={SLACK_ICON_URL}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function RulesSection({ onView, view }: SectionProps) {
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  // Each rule's last "Send test", shown under the rule.
  const [tests, setTests] = useState<Record<string, CheckResult>>({});
  const eventLabels = new Map<string, string>(
    view.events.map((event) => [event.kind, event.label]),
  );

  function setRules(rules: NotificationRule[]) {
    onView({ ...view, rules });
  }

  async function loadChannels() {
    setPending("channels");

    const result = await send<{
      result: {
        channels?: SlackChannelOption[];
        message?: string;
        ok: boolean;
      };
    }>("/api/admin/notifications", "POST", { action: "list_slack_channels" });

    setPending(null);

    const outcome = result.payload?.result;

    if (!outcome?.ok || !outcome.channels) {
      setFeedback({
        message: outcome?.message ?? result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
      return;
    }

    setChannels(outcome.channels);
  }

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft) {
      return;
    }

    setPending("save");
    setFeedback(null);

    const body = ruleBody(draft);
    const result = draft.id
      ? await send<{ rules: NotificationRule[] }>(
          `/api/admin/notifications/rules/${encodeURIComponent(draft.id)}`,
          "PUT",
          body,
        )
      : await send<{ rules: NotificationRule[] }>(
          "/api/admin/notifications/rules",
          "POST",
          body,
        );

    setPending(null);
    setErrors(result.fieldErrors);

    if (!result.payload?.rules) {
      setFeedback({
        message: result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
      return;
    }

    setRules(result.payload.rules);
    setDraft(null);
    setFeedback({ message: "Rule saved.", tone: "success" });
  }

  async function toggleRule(rule: NotificationRule) {
    setPending(rule.id);

    const result = await send<{ rules: NotificationRule[] }>(
      `/api/admin/notifications/rules/${encodeURIComponent(rule.id)}`,
      "PUT",
      {
        channel: rule.channel,
        destination: rule.destination,
        destinationName: rule.destinationName,
        enabled: !rule.enabled,
        events: rule.events,
        teamId: rule.teamId,
      },
    );

    setPending(null);

    if (result.payload?.rules) {
      setRules(result.payload.rules);
    } else {
      setFeedback({
        message: result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    }
  }

  async function deleteRule(rule: NotificationRule) {
    setPending(rule.id);

    const result = await send<{ rules: NotificationRule[] }>(
      `/api/admin/notifications/rules/${encodeURIComponent(rule.id)}`,
      "DELETE",
    );

    setPending(null);

    if (result.payload?.rules) {
      setRules(result.payload.rules);
      setFeedback({ message: "Rule deleted.", tone: "success" });
    } else {
      setFeedback({
        message: result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    }
  }

  async function testRule(rule: NotificationRule) {
    setPending(`test-${rule.id}`);
    setTests((current) => {
      const next = { ...current };

      delete next[rule.id];

      return next;
    });

    const result = await send<{ result: CheckResult }>(
      `/api/admin/notifications/rules/${encodeURIComponent(rule.id)}/test`,
      "POST",
    );

    setPending(null);

    const outcome = result.payload?.result ?? {
      message: result.error ?? GENERIC_ERROR_MESSAGE,
      ok: false,
    };

    setTests((current) => ({ ...current, [rule.id]: outcome }));
  }

  function toggleEvent(kind: NotificationEventKind, checked: boolean) {
    setDraft((current) =>
      current
        ? {
            ...current,
            events: checked
              ? [...new Set([...current.events, kind])]
              : current.events.filter((event) => event !== kind),
          }
        : current,
    );
    setErrors((current) => ({ ...current, events: "" }));
  }

  return (
    <div
      className="space-y-5 border-t border-(--border) pt-8"
      id="notification-rules"
    >
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Channel rules
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Each rule posts the events it names to one Slack channel, for every
          envelope or only for envelopes sent by one team&apos;s members (for
          example, the sales team&apos;s to #sales). A team&apos;s channel never
          hears about anyone else&apos;s envelopes, or about backups.
        </p>
      </div>

      <Notice feedback={feedback} />

      {view.rules.length === 0 ? (
        <p className="text-sm text-(--secondary)">No rules yet.</p>
      ) : (
        <ul className="space-y-3">
          {view.rules.map((rule) => (
            <li
              className="space-y-2 rounded-2xl bg-(--surface) px-5 py-4"
              key={rule.id}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold text-(--fg)">
                  {rule.destinationName
                    ? `#${rule.destinationName}`
                    : rule.destination}
                </span>
                <StatusPill tone="neutral">
                  {rule.teamName ? `${rule.teamName} only` : "Every envelope"}
                </StatusPill>
                {rule.enabled ? null : (
                  <StatusPill tone="warning">Paused</StatusPill>
                )}
              </div>
              <p className="text-sm text-(--secondary)">
                {rule.events
                  .map((event) => eventLabels.get(event) ?? event)
                  .join(", ")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-quiet"
                  disabled={pending !== null}
                  onClick={() => setDraft(draftFromRule(rule))}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="btn-quiet"
                  disabled={pending !== null || !view.slack.configured}
                  onClick={() => void testRule(rule)}
                  type="button"
                >
                  {pending === `test-${rule.id}` ? "Sending..." : "Send test"}
                </button>
                <button
                  className="btn-quiet"
                  disabled={pending !== null}
                  onClick={() => void toggleRule(rule)}
                  type="button"
                >
                  {rule.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  className="btn-quiet"
                  disabled={pending !== null}
                  onClick={() => void deleteRule(rule)}
                  type="button"
                >
                  Delete
                </button>
              </div>
              {tests[rule.id] ? (
                <p
                  className={`notice ${tests[rule.id]?.ok ? "notice-success" : "notice-danger"}`}
                  role={tests[rule.id]?.ok ? "status" : "alert"}
                >
                  {tests[rule.id]?.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <form
          className="space-y-4 rounded-2xl bg-(--surface) px-5 py-4"
          noValidate
          onSubmit={saveRule}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-bold text-(--fg)">Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {view.events.map((event) => (
                <label
                  className="flex items-start gap-2 text-sm text-(--fg)"
                  key={event.kind}
                >
                  <input
                    checked={draft.events.includes(event.kind)}
                    className="mt-1 size-4 accent-(--accent)"
                    disabled={
                      pending !== null ||
                      (event.audience === "admin" && draft.teamId !== "")
                    }
                    onChange={(change) =>
                      toggleEvent(event.kind, change.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>
                    <span className="block font-semibold">{event.label}</span>
                    <span className="block text-(--secondary)">
                      {event.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {errors.events ? (
              <p className="text-sm text-(--danger)" role="alert">
                {errors.events}
              </p>
            ) : null}
          </fieldset>

          <label className="block space-y-2 text-sm">
            <span className="font-semibold text-(--secondary)">Envelopes</span>
            <select
              className="field-input"
              disabled={pending !== null}
              onChange={(change) => {
                const teamId = change.target.value;

                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        events: teamId
                          ? current.events.filter(
                              (kind) =>
                                view.events.find((event) => event.kind === kind)
                                  ?.audience !== "admin",
                            )
                          : current.events,
                        teamId,
                      }
                    : current,
                );
              }}
              value={draft.teamId}
            >
              <option value="">Every envelope</option>
              {view.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  Only {team.name}&apos;s envelopes
                </option>
              ))}
            </select>
            {errors.teamId ? (
              <span className="block text-(--danger)">{errors.teamId}</span>
            ) : null}
          </label>

          <div className="space-y-2">
            {channels ? (
              <label className="block space-y-2 text-sm">
                <span className="font-semibold text-(--secondary)">
                  Channel
                </span>
                <select
                  className="field-input"
                  disabled={pending !== null}
                  onChange={(change) => {
                    const picked = channels.find(
                      (item) => item.id === change.target.value,
                    );

                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            destination: picked?.id ?? "",
                            destinationName: picked?.name ?? "",
                          }
                        : current,
                    );
                  }}
                  value={
                    channels.some((item) => item.id === draft.destination)
                      ? draft.destination
                      : ""
                  }
                >
                  <option value="">Choose a channel</option>
                  {channels.map((item) => (
                    <option key={item.id} value={item.id}>
                      #{item.name}
                      {item.isMember ? "" : " (invite the app first)"}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <ShellButton
                disabled={!view.slack.configured}
                loading={pending === "channels"}
                onClick={() => void loadChannels()}
                variant="secondary"
              >
                {pending === "channels" ? "Loading..." : "List Slack channels"}
              </ShellButton>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell
                disabled={pending !== null}
                error={errors.destination}
                helper="Filled in when you pick a channel, or paste a private channel's ID."
                label="Channel ID"
                name="rule-destination"
                onChange={(change) => {
                  const destination = change.target.value;

                  setDraft((current) =>
                    current ? { ...current, destination } : current,
                  );
                  setErrors((current) => ({ ...current, destination: "" }));
                }}
                placeholder="C0123456789"
                readOnly={false}
                value={draft.destination}
              />
              <FieldShell
                disabled={pending !== null}
                error={errors.destinationName}
                helper="How the rule is shown here."
                label="Channel name"
                name="rule-destination-name"
                onChange={(change) => {
                  const destinationName = change.target.value;

                  setDraft((current) =>
                    current ? { ...current, destinationName } : current,
                  );
                }}
                placeholder="sales"
                readOnly={false}
                value={draft.destinationName}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <ShellButton loading={pending === "save"} type="submit">
              {pending === "save"
                ? "Saving..."
                : draft.id
                  ? "Save rule"
                  : "Add rule"}
            </ShellButton>
            <ShellButton
              disabled={pending !== null}
              onClick={() => {
                setDraft(null);
                setErrors({});
              }}
              variant="ghost"
            >
              Cancel
            </ShellButton>
          </div>
        </form>
      ) : (
        <ShellButton
          disabled={!view.slack.configured}
          onClick={() => {
            setDraft(EMPTY_RULE);
            setErrors({});
          }}
          variant="secondary"
        >
          Add a rule
        </ShellButton>
      )}
    </div>
  );
}

function ThresholdsSection({ onView, view }: SectionProps) {
  const { thresholds } = view;
  const [values, setValues] = useState({
    expiringDays: String(thresholds.expiringDays),
    stuckDays: String(thresholds.stuckDays),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const expiringDays = parseDays(values.expiringDays);
    const stuckDays = parseDays(values.stuckDays);
    const fieldErrors: Record<string, string> = {};

    for (const [field, value] of [
      ["expiringDays", expiringDays],
      ["stuckDays", stuckDays],
    ] as const) {
      if (value === null) {
        fieldErrors[field] = "Use a whole number of days from 0 to 60.";
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }

    setSaving(true);
    setFeedback(null);

    const result = await send<{ view: NotificationsAdminView }>(
      "/api/admin/notifications",
      "PUT",
      {
        ...(thresholds.expiringFromEnv ? {} : { expiringDays }),
        ...(thresholds.stuckFromEnv ? {} : { stuckDays }),
      },
    );

    setSaving(false);
    setErrors(result.fieldErrors);

    if (!result.payload?.view) {
      setFeedback({
        message: result.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
      return;
    }

    onView(result.payload.view);
    setFeedback({ message: "Saved.", tone: "success" });
  }

  return (
    <form
      className="space-y-4 border-t border-(--border) pt-8"
      id="notification-timing"
      noValidate
      onSubmit={submit}
    >
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Deadlines and idle envelopes
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          The notifications job warns once when an envelope&apos;s deadline is
          this many days away, and once when an envelope out for signature has
          had no activity for this many days. 0 turns either off.
        </p>
      </div>
      <Notice feedback={feedback} />
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <FieldShell
          disabled={saving}
          error={errors.expiringDays}
          helper={
            thresholds.expiringFromEnv
              ? "Set by NOTIFICATION_EXPIRING_DAYS."
              : undefined
          }
          label="Days before a deadline"
          name="expiring-days"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              expiringDays: event.target.value,
            }))
          }
          readOnly={thresholds.expiringFromEnv}
          value={values.expiringDays}
        />
        <FieldShell
          disabled={saving}
          error={errors.stuckDays}
          helper={
            thresholds.stuckFromEnv
              ? "Set by NOTIFICATION_STUCK_DAYS."
              : undefined
          }
          label="Days without activity"
          name="stuck-days"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              stuckDays: event.target.value,
            }))
          }
          readOnly={thresholds.stuckFromEnv}
          value={values.stuckDays}
        />
      </div>
      <ShellButton className="w-fit" loading={saving} type="submit">
        {saving ? "Saving..." : "Save"}
      </ShellButton>
    </form>
  );
}

function DeliveryStatus({ view }: { view: NotificationsAdminView }) {
  const { deliveries } = view;
  const eventLabels = new Map<string, string>(
    view.events.map((event) => [event.kind, event.label]),
  );

  return (
    <div
      className="space-y-3 border-t border-(--border) pt-8"
      id="notification-deliveries"
    >
      <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        The last seven days
      </h3>
      <p className="text-sm leading-6 text-(--secondary)">
        {deliveries.sentLastWeek} sent, {deliveries.pending} waiting,{" "}
        {deliveries.failedLastWeek} failed, {deliveries.skippedLastWeek} skipped
        (usually someone with no Slack account at their email address),{" "}
        {deliveries.combinedLastWeek} combined into a later message.
      </p>
      {deliveries.recentProblems.length > 0 ? (
        <ul className="space-y-1 text-sm text-(--secondary)">
          {deliveries.recentProblems.map((problem, index) => (
            <li key={`${problem.at}-${index}`}>
              {new Date(problem.at * 1000).toLocaleString()}:{" "}
              {eventLabels.get(problem.event) ?? problem.event} to{" "}
              {problem.targetKind === "user" ? "a person" : "a channel"},{" "}
              {problem.status}: <code>{problem.error}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
