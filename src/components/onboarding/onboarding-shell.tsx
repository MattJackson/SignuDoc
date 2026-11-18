"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleDashedIcon,
  MinusIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { BrandMark, type BrandId } from "@/components/settings/integration-kit";
import { integrationForStep } from "@/components/settings/integrations-catalog";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/cn";
import type {
  OnboardingStepId,
  OnboardingStepState,
  OnboardingStepStatus,
} from "@/lib/onboarding/steps";

import { STEP_FORMS, type OnboardingData } from "./steps";

// Onboarding after first-run setup: a stepper. The list on the side shows
// every step with where it stands (done, skipped, needs attention, to do)
// and opens any of them; the step itself has Back, Skip and Continue.
// "done" is the summary at the end.

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

const CONFIRM_LABELS: Partial<Record<OnboardingStepId, string>> = {
  name: "Keep the organization's name",
  retention: "Keep as it is",
};

type OnboardingShellProps = {
  current: OnboardingStepId | "done";
  data: OnboardingData;
  steps: OnboardingStepState[];
};

/** The mark shown beside a step: its service's, when it sets one up. */
function stepBrand(
  step: OnboardingStepState,
  storageDriver: string | null,
): BrandId | null {
  if (step.id === "storage") {
    return storageDriver === "gcs"
      ? "google-cloud"
      : storageDriver === "blob"
        ? "vercel"
        : "local-disk";
  }

  return integrationForStep(step.id)?.brand ?? null;
}

function StepMarker({
  active,
  position,
  status,
}: {
  active: boolean;
  position: number;
  status: OnboardingStepStatus;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        status === "done"
          ? "bg-(--success-soft) text-(--success)"
          : status === "needs_attention"
            ? "bg-(--warning-soft) text-(--warning)"
            : active
              ? "bg-(--accent) text-white"
              : status === "skipped"
                ? "bg-(--surface-strong) text-(--tertiary)"
                : "bg-(--paper) text-(--secondary) ring-1 ring-(--border-strong)",
      )}
    >
      {status === "done" ? (
        <CheckIcon className="size-3.5" />
      ) : status === "needs_attention" ? (
        <TriangleAlertIcon className="size-3.5" />
      ) : status === "skipped" && !active ? (
        <MinusIcon className="size-3.5" />
      ) : (
        position
      )}
    </span>
  );
}

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
  const percent = Math.round((done / Math.max(steps.length, 1)) * 100);
  const brand = step ? stepBrand(step, data.storage.driver) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        action={
          <ShellButton href="/dashboard" variant="ghost">
            Finish later
          </ShellButton>
        }
        description="Each step can be skipped and opened again later, here or from Settings."
        title="Set up this site"
      />

      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label="Setup steps"
          className="panel min-w-0 space-y-4 p-4 lg:sticky lg:top-6"
          data-animate="enter"
        >
          <div className="space-y-2 px-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-bold text-(--fg)">Progress</p>
              <p className="text-xs font-semibold text-(--tertiary)">
                {done} of {steps.length} done
              </p>
            </div>
            <div
              aria-label="Setup progress"
              aria-valuemax={steps.length}
              aria-valuemin={0}
              aria-valuenow={done}
              aria-valuetext={`${String(done)} of ${String(steps.length)} steps done`}
              className="h-2 overflow-hidden rounded-full bg-(--surface-strong)"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-(--accent) transition-[width]"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
          </div>

          <ol className="flex gap-1 overflow-x-auto lg:block lg:space-y-0.5 lg:overflow-visible">
            {steps.map((item, position) => {
              const active = item.id === current;

              return (
                <li className="shrink-0" key={item.id}>
                  <Link
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition",
                      active ? "bg-(--accent-softer)" : "hover:bg-(--surface)",
                    )}
                    href={`/onboarding?step=${item.id}`}
                  >
                    <StepMarker
                      active={active}
                      position={position + 1}
                      status={item.status}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block truncate whitespace-nowrap lg:whitespace-normal",
                          active
                            ? "font-bold text-(--accent-ink)"
                            : "font-semibold text-(--fg)",
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="hidden text-xs text-(--tertiary) lg:block">
                        {STATUS_LABELS[item.status]}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
            <li className="shrink-0">
              <Link
                aria-current={current === "done" ? "step" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition",
                  current === "done"
                    ? "bg-(--accent-softer) font-bold text-(--accent-ink)"
                    : "font-semibold text-(--fg) hover:bg-(--surface)",
                )}
                href="/onboarding?step=done"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-(--paper) text-(--secondary) ring-1 ring-(--border-strong)"
                >
                  <CircleDashedIcon className="size-3.5" />
                </span>
                Summary
              </Link>
            </li>
          </ol>
        </nav>

        <section
          className="panel space-y-6 p-6 sm:p-8"
          data-animate="enter"
          data-step={current}
        >
          {step && Form ? (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                {brand ? <BrandMark brand={brand} size="lg" /> : null}
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="section-eyebrow">
                    Step {index + 1} of {steps.length}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
                      {step.title}
                    </h2>
                    <span className={`pill ${STATUS_PILLS[step.status]}`}>
                      {STATUS_LABELS[step.status]}
                    </span>
                  </div>
                  <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                    {step.summary}
                  </p>
                  <p className="max-w-2xl text-[0.8125rem] leading-5 text-(--tertiary)">
                    {step.detail}
                  </p>
                </div>
                <Link
                  className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-(--secondary) transition hover:text-(--fg)"
                  href={step.settingsHref}
                >
                  <SettingsIcon aria-hidden="true" className="size-3.5" />
                  Open in Settings
                </Link>
              </div>

              <div className="border-t border-(--border) pt-6">
                <Form
                  data={data}
                  key={step.id}
                  onChanged={() => router.refresh()}
                />
              </div>

              {error ? (
                <p className="notice notice-danger" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-col-reverse gap-3 border-t border-(--border) pt-6 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  {previousHref ? (
                    <ShellButton href={previousHref} variant="ghost">
                      <ArrowLeftIcon aria-hidden="true" className="size-4" />
                      Back
                    </ShellButton>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
                      {CONFIRM_LABELS[step.id] ?? "Mark as done"}
                    </ShellButton>
                  ) : null}
                  <ShellButton href={nextHref}>
                    {index === steps.length - 1 ? "Finish" : "Continue"}
                    <ArrowRightIcon aria-hidden="true" className="size-4" />
                  </ShellButton>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <p className="section-eyebrow">Summary</p>
                <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
                  {done === steps.length ? "All set" : "That's the tour"}
                </h2>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  {done === steps.length
                    ? "Every step is done. People can sign in and start sending documents."
                    : "Some steps are still open. They stay in the setup checklist in Settings, where any step can be opened again."}
                </p>
              </div>
              {done < steps.length ? (
                <ul className="divide-y divide-(--border) rounded-2xl border border-(--border)">
                  {steps
                    .filter((item) => item.status !== "done")
                    .map((item) => (
                      <li key={item.id}>
                        <Link
                          className="flex flex-col gap-1 px-5 py-3.5 transition hover:bg-(--surface) sm:flex-row sm:items-center sm:justify-between"
                          href={`/onboarding?step=${item.id}`}
                        >
                          <span className="space-y-0.5">
                            <span className="block text-sm font-bold text-(--fg)">
                              {item.title}
                            </span>
                            <span className="block text-sm leading-6 text-(--secondary)">
                              {item.detail}
                            </span>
                          </span>
                          <span
                            className={`pill w-fit ${STATUS_PILLS[item.status]}`}
                          >
                            {STATUS_LABELS[item.status]}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2 border-t border-(--border) pt-6">
                <ShellButton href="/dashboard">Go to documents</ShellButton>
                <ShellButton href="/settings/setup" variant="secondary">
                  Open the setup checklist
                </ShellButton>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
