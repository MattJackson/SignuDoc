"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { buttonVariants } from "@/components/ui/button";
import type {
  WorkspaceCheck,
  WorkspaceCheckTarget,
  WorkspaceGuideStep,
  WorkspaceSetupEvent,
  WorkspaceSetupStepStatus,
} from "@/lib/workspace/types";
import type { WorkspaceSetupView } from "@/lib/workspace/workspace-setup";

// Setting the workspace provider up, on its own page: step by step (the
// provider's guide: a link, this site's values to copy, a field to paste
// into and a test for each step), or automatically (one sign-in as the
// provider's administrator, then the server does the steps and shows each
// as it goes). Nothing here names a provider: it lays out what the
// provider's setup describes.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const INTERRUPTED_MESSAGE = "The setup stopped before it finished.";
const INTERRUPTED_HINT =
  "Run it again; what is done already is kept. The one-time sign-in was never stored, and it expires within the hour.";

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "The sign-in was cancelled. Nothing was changed.",
  not_ready:
    "The automatic setup cannot start yet. Check the note above, or set it up step by step.",
};

export type WorkspaceSetupCallback = {
  code: string | null;
  error: string | null;
  state: string | null;
};

type StepState = {
  detail: string;
  hint?: string;
  providerStatus?: number | null;
  status: WorkspaceSetupStepStatus;
  title: string;
};

type Offer = Extract<WorkspaceSetupEvent, { type: "choose" }>;

type RunState = {
  /** The choice offered, while the run waits for it. */
  choice: Offer | null;
  finished: { ok: boolean; revoked: boolean } | null;
  refused: { hint?: string; message: string } | null;
  running: boolean;
  steps: Record<string, StepState>;
};

const EMPTY_RUN: RunState = {
  choice: null,
  finished: null,
  refused: null,
  running: false,
  steps: {},
};

function apply(current: RunState, event: WorkspaceSetupEvent): RunState {
  switch (event.type) {
    case "choose":
      return { ...current, choice: event };
    case "waiting":
      return current;
    case "step":
      return {
        ...current,
        choice: null,
        steps: {
          ...current.steps,
          [event.id]: {
            detail: event.detail,
            hint: event.hint,
            providerStatus: event.providerStatus,
            status: event.status,
            title: event.title,
          },
        },
      };
    case "refused":
      return {
        ...current,
        choice: null,
        refused: { hint: event.hint, message: event.message },
      };
    case "finished":
      return {
        ...current,
        choice: null,
        finished: { ok: event.ok, revoked: event.revoked },
        running: false,
      };
  }
}

/** Runs the setup with the code the provider sent back, reading each step live. */
function useSetupRun(callback: WorkspaceSetupCallback) {
  // Coming back with a code, the run starts at once.
  const [run, setRun] = useState<RunState>(() =>
    callback.code && callback.state
      ? { ...EMPTY_RUN, running: true }
      : EMPTY_RUN,
  );
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !callback.code || !callback.state) {
      return;
    }

    started.current = true;

    const { code, state } = callback;

    // The code is used once; it should not stay in the address bar.
    window.history.replaceState(null, "", window.location.pathname);

    void (async () => {
      let streamed = false;

      try {
        const response = await fetch("/api/admin/workspace/setup/run", {
          body: JSON.stringify({ code, state }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;

          setRun({
            ...EMPTY_RUN,
            refused: { message: payload?.error ?? GENERIC_ERROR_MESSAGE },
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";

        streamed = true;

        for (;;) {
          const { done, value } = await reader.read();

          buffered += decoder.decode(value, { stream: !done });

          const lines = buffered.split("\n");

          buffered = lines.pop() ?? "";

          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line) as WorkspaceSetupEvent;

            setRun((current) => apply(current, event));
          }

          if (done) {
            break;
          }
        }
      } catch {
        setRun((current) => ({
          ...current,
          refused: current.refused ?? { message: GENERIC_ERROR_MESSAGE },
        }));
      } finally {
        // A stream cut off before the end (a time limit, a proxy) sends no
        // "finished": say so, rather than leave steps at "Working".
        setRun((current) =>
          current.finished || !streamed
            ? { ...current, running: false }
            : {
                ...current,
                refused: {
                  hint: current.refused?.hint ?? INTERRUPTED_HINT,
                  message: current.refused?.message ?? INTERRUPTED_MESSAGE,
                },
                running: false,
              },
        );
      }
    })();
  }, [callback]);

  return run;
}

async function sendJson<T>(url: string, method: string, body: unknown) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
  const payload = (await response.json().catch(() => null)) as
    (T & { error?: string; fieldErrors?: Record<string, string> }) | null;

  return { ok: response.ok, payload };
}

const STATUS_LABELS: Record<WorkspaceSetupStepStatus | "waiting", string> = {
  action: "Your turn",
  done: "Done",
  failed: "Failed",
  running: "Working",
  skipped: "Already done",
  waiting: "Waiting",
};

function noticeTone(status: WorkspaceSetupStepStatus | "waiting"): string {
  switch (status) {
    case "done":
    case "skipped":
      return "notice-success";
    case "failed":
      return "notice-danger";
    case "action":
      return "notice-warning";
    default:
      return "notice-accent";
  }
}

export function WorkspaceSetupPanel({
  callback,
  hosted,
  view,
}: {
  callback: WorkspaceSetupCallback;
  hosted: boolean;
  view: WorkspaceSetupView;
}) {
  const automatic = hosted ? null : view.automatic;
  const [mode, setMode] = useState<"automatic" | "manual">(
    automatic ? "automatic" : "manual",
  );

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      id="workspace-setup"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Set up {view.provider.label}
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            Run it again whenever something needs fixing; what is in place is
            kept. Nothing secret is stored in the database: keys and client
            secrets stay where the site runs.{" "}
            <Link className="underline" href="/settings#workspace">
              Back to Settings
            </Link>
          </p>
          {view.providers.length > 1 ? (
            <p className="text-sm leading-6 text-(--secondary)">
              Set up another:{" "}
              {view.providers
                .filter((provider) => provider.id !== view.provider.id)
                .map((provider) => (
                  <Link
                    className="mr-3 underline"
                    href={`/settings/workspace-setup?provider=${encodeURIComponent(provider.id)}`}
                    key={provider.id}
                  >
                    {provider.label}
                  </Link>
                ))}
            </p>
          ) : null}
        </div>

        {automatic && view.guide ? (
          <fieldset className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <legend className="sr-only">How to set it up</legend>
            {(
              [
                [
                  "automatic",
                  "Automatically",
                  "Sign in once; the site does each step and tests it.",
                ],
                [
                  "manual",
                  "Step by step",
                  "Do each step yourself, with links, values to copy and a test.",
                ],
              ] as const
            ).map(([value, title, description]) => (
              <label
                className="flex cursor-pointer gap-3 rounded-2xl bg-(--surface) px-4 py-3.5"
                key={value}
              >
                <input
                  checked={mode === value}
                  className="mt-1 size-4 accent-(--accent)"
                  name="workspace-setup-mode"
                  onChange={() => setMode(value)}
                  type="radio"
                />
                <span className="space-y-1">
                  <span className="block text-sm font-bold text-(--fg)">
                    {title}
                  </span>
                  <span className="block text-sm leading-6 text-(--secondary)">
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {mode === "automatic" && automatic ? (
          <AutomaticSetup
            automatic={automatic}
            callback={callback}
            providerId={view.provider.id}
          />
        ) : view.guide ? (
          <Guide guide={view.guide} providerId={view.provider.id} />
        ) : (
          <p className="text-sm leading-6 text-(--secondary)">
            {view.provider.label} has no setup guide.
          </p>
        )}
      </div>
    </section>
  );
}

function AutomaticSetup({
  automatic,
  callback,
  providerId,
}: {
  automatic: NonNullable<WorkspaceSetupView["automatic"]>;
  callback: WorkspaceSetupCallback;
  providerId: string;
}) {
  const run = useSetupRun(callback);
  const [toggles, setToggles] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      automatic.toggles.map((toggle) => [toggle.id, toggle.defaultOn]),
    ),
  );
  const callbackError = callback.error
    ? (CALLBACK_ERRORS[callback.error] ??
      `The sign-in did not finish (${callback.error.slice(0, 60)}).`)
    : null;
  const startUrl = `/api/admin/workspace/setup/start?${new URLSearchParams({
    provider: providerId,
    ...Object.fromEntries(
      Object.entries(toggles).map(([id, on]) => [id, on ? "1" : "0"]),
    ),
  }).toString()}`;
  const showRun = run.running || run.finished !== null || run.refused !== null;

  return (
    <div className="space-y-5">
      <div className="max-w-2xl space-y-2 text-sm leading-6 text-(--secondary)">
        {automatic.signIn.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      <ol className="max-w-2xl list-decimal space-y-1 pl-5 text-sm leading-6 text-(--secondary)">
        {automatic.steps.map((step) => (
          <li key={step.id}>{step.title}</li>
        ))}
      </ol>

      {automatic.toggles.map((toggle) => (
        <label
          className="flex items-center gap-3 text-sm font-semibold text-(--fg)"
          key={toggle.id}
        >
          <input
            checked={toggles[toggle.id] ?? toggle.defaultOn}
            className="size-4 accent-(--accent)"
            onChange={(event) =>
              setToggles((current) => ({
                ...current,
                [toggle.id]: event.target.checked,
              }))
            }
            type="checkbox"
          />
          {toggle.label}
        </label>
      ))}

      {automatic.problem ? (
        <p className="notice notice-warning max-w-2xl" role="status">
          {automatic.problem}
        </p>
      ) : null}

      {automatic.problem || run.running ? (
        <ShellButton disabled>Sign in and set it up</ShellButton>
      ) : (
        // A full page load: the route answers with a redirect to the
        // provider's sign-in.
        <a className={buttonVariants({ className: "w-fit" })} href={startUrl}>
          {run.finished ? "Run the setup again" : "Sign in and set it up"}
        </a>
      )}

      {callbackError ? (
        <p className="notice notice-danger max-w-2xl" role="alert">
          {callbackError}
        </p>
      ) : null}

      {showRun ? <RunResults run={run} /> : null}
    </div>
  );
}

function RunResults({ run }: { run: RunState }) {
  return (
    <div aria-live="polite" className="max-w-2xl space-y-3">
      {run.choice ? (
        <Chooser key={run.choice.runId} offer={run.choice} />
      ) : null}
      <ol className="space-y-2">
        {Object.entries(run.steps).map(([id, step]) => (
          <li
            className={`notice ${noticeTone(step.status)}`}
            data-testid={`workspace-setup-step-${id}`}
            key={id}
          >
            <p>
              <strong>{step.title}</strong>{" "}
              <span className="text-xs">{STATUS_LABELS[step.status]}</span>
            </p>
            {step.detail ? (
              <p>
                {step.detail}
                {step.providerStatus
                  ? ` (The provider answered ${String(step.providerStatus)}.)`
                  : ""}
              </p>
            ) : null}
            {step.hint ? <p className="break-words">{step.hint}</p> : null}
          </li>
        ))}
      </ol>
      {run.refused ? (
        <div className="notice notice-danger" role="alert">
          <p>{run.refused.message}</p>
          {run.refused.hint ? <p>{run.refused.hint}</p> : null}
        </div>
      ) : null}
      {run.finished ? (
        <p
          className={`notice ${run.finished.ok ? "notice-success" : "notice-warning"}`}
          role="status"
        >
          {run.finished.ok
            ? "Everything is set up."
            : "Not everything is set up yet. Do what is marked above and run the setup again; what is done already is kept."}{" "}
          {run.finished.revoked
            ? "The one-time sign-in has been revoked, and it was never stored."
            : "The one-time sign-in was never stored and expires within the hour."}
        </p>
      ) : null}
    </div>
  );
}

/** A choice the run waits for, such as the Cloud project to use. */
function Chooser({ offer }: { offer: Offer }) {
  const [selected, setSelected] = useState(
    offer.preselected ?? offer.options[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);

    const { ok, payload } = await sendJson<{ ok?: boolean }>(
      "/api/admin/workspace/setup/choose",
      "POST",
      { choice: selected, runId: offer.runId },
    ).catch(() => ({ ok: false, payload: null }));

    setPending(false);

    if (ok) {
      setSent(true);
    } else {
      setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
    }
  }

  return (
    <div className="space-y-3 rounded-2xl bg-(--surface) px-4 py-3.5">
      <p className="text-sm font-bold text-(--fg)">{offer.question}</p>
      <p className="text-sm leading-6 text-(--secondary)">
        Choose within {offer.waitSeconds} seconds.
        {offer.reason ? ` ${offer.reason}` : ""}
      </p>
      <fieldset className="max-h-72 space-y-1 overflow-y-auto">
        <legend className="sr-only">{offer.question}</legend>
        {offer.options.map((option) => (
          <label
            className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-sm"
            key={option.id}
          >
            <input
              checked={selected === option.id}
              className="size-4 accent-(--accent)"
              disabled={pending || sent}
              name="workspace-setup-choice"
              onChange={() => setSelected(option.id)}
              type="radio"
            />
            <span>
              <span className="font-semibold text-(--fg)">{option.label}</span>{" "}
              {option.detail ? (
                <span className="text-(--tertiary)">{option.detail}</span>
              ) : null}
              {option.id === offer.preselected ? (
                <span className="text-(--tertiary)"> (suggested)</span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <ShellButton
        disabled={pending || sent || !selected}
        loading={pending}
        onClick={() => void submit()}
      >
        {sent ? "Setting up..." : "Use this one"}
      </ShellButton>
      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Guide({
  guide,
  providerId,
}: {
  guide: NonNullable<WorkspaceSetupView["guide"]>;
  providerId: string;
}) {
  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
        {guide.intro}
      </p>
      <ol className="space-y-6">
        {guide.steps.map((step, index) => (
          <GuideStep
            index={index}
            key={step.id}
            providerId={providerId}
            step={step}
          />
        ))}
      </ol>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl text-sm leading-6 text-(--secondary)">
      {children}
    </div>
  );
}

function GuideStep({
  index,
  providerId,
  step,
}: {
  index: number;
  providerId: string;
  step: WorkspaceGuideStep;
}) {
  return (
    <li
      className="space-y-4 border-t border-(--border) pt-6"
      data-testid={`workspace-guide-${step.id}`}
    >
      <h2 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        {index + 1}. {step.title}
        {step.optional ? (
          <span className="ml-2 text-xs font-semibold text-(--tertiary)">
            Optional
          </span>
        ) : null}
        {step.done ? (
          <span className="ml-2 text-xs font-semibold text-(--success)">
            In place
          </span>
        ) : null}
      </h2>

      <Section>
        <ol className="list-decimal space-y-1 pl-5">
          {step.instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </Section>

      {step.links.length > 0 ? (
        <Section>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {step.links.map((link) => (
              <li key={link.href}>
                <a
                  className="underline"
                  href={link.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {step.values.length > 0 ? (
        <div className="grid max-w-2xl gap-3">
          {step.values.map((value) => (
            <CopyValue
              hint={value.hint}
              key={value.label}
              label={value.label}
              value={value.value}
            />
          ))}
        </div>
      ) : null}

      {step.fields.length > 0 ? (
        <StepFields providerId={providerId} step={step} />
      ) : null}

      {step.check ? (
        <CheckButton providerId={providerId} target={step.check} />
      ) : null}
    </li>
  );
}

function CopyValue({
  hint,
  label,
  value,
}: {
  hint?: string;
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="grid gap-1">
      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
        {label}
      </span>
      <div className="flex items-start gap-2">
        <code className="block min-w-0 flex-1 break-all rounded-xl bg-(--surface) px-3 py-2 text-sm text-(--fg)">
          {value}
        </code>
        <button
          className="btn-quiet min-h-9 px-3 text-sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint ? (
        <span className="text-xs leading-5 text-(--tertiary)">{hint}</span>
      ) : null}
    </div>
  );
}

/** The step's fields, saved together. */
function StepFields({
  providerId,
  step,
}: {
  providerId: string;
  step: WorkspaceGuideStep;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      step.fields.map((field) => [field.setting, field.value ?? ""]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const editable = step.fields.filter((field) => field.source !== "env");

  async function save() {
    setSaving(true);
    setFeedback(null);
    setErrors({});

    try {
      const { ok, payload } = await sendJson<{ changed?: string[] }>(
        "/api/admin/workspace/setup",
        "PUT",
        {
          provider: providerId,
          settings: Object.fromEntries(
            editable.map((field) => [
              field.setting,
              values[field.setting] ?? "",
            ]),
          ),
        },
      );

      if (!ok) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          ok: false,
        });
        return;
      }

      setFeedback({ message: "Saved.", ok: true });
      router.refresh();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, ok: false });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        {step.fields.map((field) => (
          <FieldShell
            autoComplete="off"
            disabled={saving || field.source === "env"}
            error={errors[field.setting]}
            helper={
              field.source === "env"
                ? `Set by ${field.env} on the server.`
                : `Or set ${field.env} on the server.`
            }
            key={field.setting}
            label={field.label}
            name={`workspace-setup-${field.setting}`}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.setting]: event.target.value,
              }))
            }
            placeholder={field.placeholder}
            readOnly={field.source === "env"}
            value={values[field.setting] ?? ""}
          />
        ))}
      </div>
      {editable.length > 0 ? (
        <ShellButton
          className="w-fit"
          loading={saving}
          onClick={() => void save()}
          variant="secondary"
        >
          {saving ? "Saving..." : "Save this step"}
        </ShellButton>
      ) : null}
      {feedback ? (
        <p
          className={`notice ${feedback.ok ? "notice-success" : "notice-danger"}`}
          role={feedback.ok ? "status" : "alert"}
        >
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

/** Runs the step's checks on what is saved, as the administrator. */
function CheckButton({
  providerId,
  target,
}: {
  providerId: string;
  target: WorkspaceCheckTarget;
}) {
  const [checks, setChecks] = useState<WorkspaceCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    setChecks(null);

    try {
      const { ok, payload } = await sendJson<{ checks?: WorkspaceCheck[] }>(
        "/api/admin/workspace/setup",
        "POST",
        { provider: providerId, target },
      );

      if (!ok || !payload?.checks) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setChecks(payload.checks);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-3">
      <ShellButton
        className="w-fit"
        loading={running}
        onClick={() => void run()}
        variant="secondary"
      >
        {running ? "Testing..." : "Test this step"}
      </ShellButton>
      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}
      {checks?.length === 0 ? (
        <p className="notice notice-warning" role="status">
          Nothing to test yet.
        </p>
      ) : null}
      {checks?.map((check) => (
        <p
          className={`notice ${check.ok ? "notice-success" : "notice-danger"}`}
          key={check.id}
          role="status"
        >
          <strong>{check.name}:</strong> {check.message}
        </p>
      ))}
    </div>
  );
}
