"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import type {
  OnboardingStepId,
  OnboardingStepState,
  OnboardingStepStatus,
} from "@/lib/onboarding/steps";

import { STEP_FORMS, type OnboardingData } from "./steps";

// Onboarding after first-run setup: one step at a time, each of which can
// be skipped and come back to. The list on the side shows every step's
// status and opens any of them. "done" is the summary at the end.

const STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  done: "Done",
  needs_attention: "Needs attention",
  not_started: "To do",
  skipped: "Skipped",
};

const STATUS_PILLS: Record<OnboardingStepStatus, string> = {
  done: "pill-success",
  needs_attention: "pill-warning",
  not_started: "pill-neutral",
  skipped: "pill-neutral",
};

type OnboardingShellProps = {
  current: OnboardingStepId | "done";
  data: OnboardingData;
  steps: OnboardingStepState[];
};

export function OnboardingShell({
  current,
  data,
  steps,
}: OnboardingShellProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const index = steps.findIndex((step) => step.id === current);
  const step = index >= 0 ? steps[index] : undefined;
  const nextHref =
    index >= 0 && index < steps.length - 1
      ? `/onboarding?step=${steps[index + 1]!.id}`
      : "/onboarding?step=done";
  const previousHref =
    index > 0
      ? `/onboarding?step=${steps[index - 1]!.id}`
      : index === -1
        ? `/onboarding?step=${steps[steps.length - 1]!.id}`
        : null;

  async function mark(value: "confirmed" | "skipped" | null, thenGo: boolean) {
    if (!step) {
      return;
    }

    setPending(value ?? "clear");
    setError(null);

    try {
      const response = await fetch("/api/admin/onboarding", {
        body: JSON.stringify({ action: "mark", mark: value, stepId: step.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        setError("That could not be saved. Please try again.");
        return;
      }

      if (thenGo) {
        router.push(nextHref);
      }

      router.refresh();
    } catch {
      setError("That could not be saved. Please try again.");
    } finally {
      setPending(null);
    }
  }

  const Form = step ? STEP_FORMS[step.id] : null;
  const done = steps.filter((item) => item.status === "done").length;

  return (
    <div className="space-y-6">
      <PageHeader
        action={
          <ShellButton href="/dashboard" variant="ghost">
            Finish later
          </ShellButton>
        }
        description={`${String(done)} of ${String(steps.length)} steps done. Every step can be skipped and opened again from the setup checklist in Settings.`}
        title="Set up this site"
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <nav aria-label="Onboarding steps" className="panel h-fit p-3">
          <ol className="space-y-1">
            {steps.map((item, position) => (
              <li key={item.id}>
                <Link
                  aria-current={item.id === current ? "step" : undefined}
                  className={`flex items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-sm ${
                    item.id === current
                      ? "bg-(--accent-softer) font-bold text-(--fg)"
                      : "text-(--secondary) hover:bg-(--surface)"
                  }`}
                  href={`/onboarding?step=${item.id}`}
                >
                  <span>
                    {position + 1}. {item.title}
                  </span>
                  <span className={`pill ${STATUS_PILLS[item.status]}`}>
                    {STATUS_LABELS[item.status]}
                  </span>
                </Link>
              </li>
            ))}
            <li>
              <Link
                aria-current={current === "done" ? "step" : undefined}
                className={`flex rounded-2xl px-3 py-2.5 text-sm ${
                  current === "done"
                    ? "bg-(--accent-softer) font-bold text-(--fg)"
                    : "text-(--secondary) hover:bg-(--surface)"
                }`}
                href="/onboarding?step=done"
              >
                Done
              </Link>
            </li>
          </ol>
        </nav>

        <section className="panel space-y-6 p-6 sm:p-8" data-step={current}>
          {step && Form ? (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
                    {step.title}
                  </h2>
                  <span className={`pill ${STATUS_PILLS[step.status]}`}>
                    {STATUS_LABELS[step.status]}
                  </span>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  {step.summary} {step.detail}
                </p>
              </div>

              <Form
                data={data}
                key={step.id}
                onChanged={() => router.refresh()}
              />

              {error ? (
                <p className="notice notice-danger" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-(--border) pt-6">
                {previousHref ? (
                  <ShellButton href={previousHref} variant="ghost">
                    Back
                  </ShellButton>
                ) : null}
                {step.status !== "done" ? (
                  <ShellButton
                    disabled={pending !== null}
                    loading={pending === "skipped"}
                    onClick={() => void mark("skipped", true)}
                    variant="ghost"
                  >
                    Skip for now
                  </ShellButton>
                ) : null}
                {step.confirmable && step.status !== "done" ? (
                  <ShellButton
                    disabled={pending !== null}
                    loading={pending === "confirmed"}
                    onClick={() => void mark("confirmed", true)}
                    variant="secondary"
                  >
                    {step.id === "retention" ? "Keep as it is" : "Mark as done"}
                  </ShellButton>
                ) : null}
                <ShellButton href={nextHref}>Next step</ShellButton>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
                {done === steps.length ? "All set" : "That's the tour"}
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                {done === steps.length
                  ? "Every step is done. People can sign in and start sending documents."
                  : "Some steps are still open. They stay in the setup checklist in Settings, where any step can be opened again."}
              </p>
              <ul className="space-y-1 text-sm text-(--secondary)">
                {steps
                  .filter((item) => item.status !== "done")
                  .map((item) => (
                    <li key={item.id}>
                      <Link
                        className="font-semibold text-(--accent-ink) underline underline-offset-4"
                        href={`/onboarding?step=${item.id}`}
                      >
                        {item.title}
                      </Link>{" "}
                      ({STATUS_LABELS[item.status].toLowerCase()})
                    </li>
                  ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <ShellButton href="/dashboard">Go to documents</ShellButton>
                <ShellButton href="/settings#setup-checklist" variant="ghost">
                  Open Settings
                </ShellButton>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
